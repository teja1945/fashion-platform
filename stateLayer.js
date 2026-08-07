/**
 * stateLayer.js — Schema v2 (multi-tenant)
 *
 * Adaptasi dari LTOS stateLayer.js lama. Perbedaan utama dari versi LTOS:
 * - order_state -> production_jobs (kolom jauh lebih ramping: cuma
 *   current_stage, current_version, gap_status. Detail order lain seperti
 *   customer_name/status ada di tabel `orders`, bukan tanggung jawab file ini)
 * - events -> production_events
 * - entity_id -> production_job_id
 * - entity_version (LTOS) -> sequence_version (schema v2), strict increment
 *   per production_job_id
 * - event.version (skema payload, lihat db/EVENT_CONTRACTS.md) -> kolom
 *   event_version, TIDAK PERLU dipakai untuk urutan apply, cuma metadata
 * - gap_status table (LTOS) -> kolom gap_status di production_jobs +
 *   event gap.opened/gap.escalated/gap.resolved di production_events
 *   (pola ini sudah dipakai worker.js, lihat CHECKPOINT bagian 31)
 * - pending_events & stale_event_log: sekarang ada di schema v2 (baru
 *   ditambah lewat migration add_pending_events_and_stale_event_log,
 *   sebelumnya kelewat pas migrasi schema v2 pertama)
 *
 * PENTING — production_jobs SELALU sudah ada sebelum event apapun diproses.
 * Row-nya dibuat di versioning.js (bukan di file ini), pas event
 * order.confirmed_for_production masuk (lihat CHECKPOINT bagian
 * evaluasi ulang saran ChatGPT soal production_jobs/next_sequence_version).
 * File ini TIDAK PERNAH insert row baru ke production_jobs — kalau
 * row-nya belum ada, itu artinya ada bug di versioning.js/ingestion.js,
 * bukan kasus normal yang perlu ditolerir di sini.
 *
 * PENTING — RLS & tenant context:
 * File ini TIDAK membuka koneksi sendiri dari pool. Semua fungsi menerima
 * `client` sebagai parameter pertama — client ini WAJIB sudah berada di
 * dalam transaction yang sudah di-SET LOCAL app.tenant_id (lihat pola
 * withTenant() di db.js / CHECKPOINT bagian 22). Ini supaya RLS
 * benar-benar aktif per operasi, bukan cuma dekorasi.
 * Pemanggil (ingestion.js) bertanggung jawab untuk:
 *   1. Resolve order_id -> production_job_id SEBELUM insert ke
 *      production_events (production_job_id wajib ada di row event)
 *   2. Buka transaction + SET LOCAL app.tenant_id sebelum manggil
 *      tryApplyToState()
 *
 * Field yang ditulis ke production_jobs.current_stage: HANYA event
 * order.stage_changed yang punya field to_stage di payload-nya (lihat
 * EVENT_CONTRACTS.md). Event lain (order.created, payment.*, qc.*, dst)
 * tetap di-apply untuk keperluan versioning/gap-tracking, tapi tidak
 * mengubah current_stage karena memang tidak ada field yang relevan.
 */

/**
 * Terapkan satu event ke production_jobs (projection tipis), dengan:
 * - strict increment check (last_version + 1) berbasis sequence_version
 * - buffer ke pending_events kalau out-of-order (gap)
 * - optimistic locking dengan aturan discard/retry yang tegas
 * - chain-apply otomatis kalau gap tertutup
 *
 * @param {object} client - pg client, sudah dalam transaction + SET LOCAL tenant
 * @param {object} event - row dari production_events:
 *   { id, tenant_id, production_job_id, event_type, event_version, payload, sequence_version }
 */
async function tryApplyToState(client, event) {
  const { tenant_id, production_job_id, sequence_version } = event;

  const trackerRes = await client.query(
    `SELECT current_version FROM production_jobs WHERE id = $1`,
    [production_job_id]
  );
  const lastApplied = parseInt(trackerRes.rows[0]?.current_version ?? 0, 10);

  if (sequence_version <= lastApplied) {
    // stale / duplikat — bukan error, cuma diabaikan dan dicatat
    await client.query(
      `INSERT INTO stale_event_log (tenant_id, production_job_id, sequence_version, event_id, reason)
       VALUES ($1, $2, $3, $4, 'stale_or_duplicate')`,
      [tenant_id, production_job_id, sequence_version, event.id]
    );
    return { applied: false, reason: "stale_or_duplicate" };
  }

  if (sequence_version > lastApplied + 1) {
    // gap terdeteksi — buffer, jangan apply dulu
    await client.query(
      `INSERT INTO pending_events (tenant_id, production_job_id, sequence_version, event_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (production_job_id, sequence_version) DO NOTHING`,
      [tenant_id, production_job_id, sequence_version, event.id]
    );
    await openGapIfNeeded(client, tenant_id, production_job_id);
    return { applied: false, reason: "buffered_gap" };
  }

  // sequence_version == lastApplied + 1 -> apply dengan optimistic lock
  const applied = await applyWithOptimisticLock(client, event, lastApplied);
  if (applied) {
    await closeGapIfOpen(client, production_job_id);
    await chainApplyFromBuffer(client, tenant_id, production_job_id);
  }
  return { applied };
}

async function applyWithOptimisticLock(client, event, expectedPreviousVersion, retryCount = 0) {
  const { production_job_id, sequence_version, event_type, payload } = event;

  // current_stage cuma di-update kalau event-nya order.stage_changed
  // (satu-satunya event yang punya field relevan, lihat EVENT_CONTRACTS.md)
  const newStage = event_type === "order.stage_changed" ? payload?.to_stage || null : null;

  const updateRes = await client.query(
    `UPDATE production_jobs SET
        current_version = $1,
        current_stage = COALESCE($2, current_stage),
        updated_at = now()
     WHERE id = $3 AND current_version = $4`,
    [sequence_version, newStage, production_job_id, expectedPreviousVersion]
  );

  if (updateRes.rowCount === 0) {
    // production_jobs SELALU sudah ada duluan (dibuat di versioning.js) —
    // jadi 0 row affected di sini cuma berarti version mismatch (race
    // condition antar-request), bukan "row belum ada". Aturan
    // discard/retry yang eksplisit:
    const recheck = await client.query(
      `SELECT current_version FROM production_jobs WHERE id = $1`,
      [production_job_id]
    );
    const actualCurrent = parseInt(recheck.rows[0]?.current_version ?? 0, 10);

    if (actualCurrent >= sequence_version) {
      // sudah diproses proses lain -> DISCARD, jangan retry apply
      return false;
    }
    if (retryCount >= 3) {
      console.error(`optimistic lock retry exhausted for production_job ${production_job_id}`);
      return false;
    }
    // current masih di belakang -> retry dengan expected_previous_version terbaru
    return applyWithOptimisticLock(client, event, actualCurrent, retryCount + 1);
  }

  return true;
}

async function openGapIfNeeded(client, tenant_id, production_job_id) {
  const res = await client.query(
    `UPDATE production_jobs SET gap_status = 'OPEN', updated_at = now()
     WHERE id = $1 AND gap_status = 'CLOSED'
     RETURNING id`,
    [production_job_id]
  );
  if (res.rowCount > 0) {
    const jobRes = await client.query(
      `SELECT current_version FROM production_jobs WHERE id = $1`,
      [production_job_id]
    );
    const markerVersion = parseInt(jobRes.rows[0]?.current_version ?? 0, 10);
    await client.query(
      `INSERT INTO gap_audit_log (tenant_id, production_job_id, reason, version_at_gap)
       VALUES ($1, $2, $3, $4)`,
      [tenant_id, production_job_id, "out_of_order_event", markerVersion]
    );
  }
}

async function closeGapIfOpen(client, production_job_id) {
  await client.query(
    `UPDATE production_jobs SET gap_status = 'CLOSED', updated_at = now()
     WHERE id = $1 AND gap_status IN ('OPEN', 'RECOVERING')`,
    [production_job_id]
  );
  // Catatan: event gap.resolved untuk kasus auto-close (bukan manual via
  // manuallyResolveGap di worker.js) sengaja tidak diinsert di sini untuk
  // menghindari duplikasi keputusan desain dengan worker.js. Kalau nanti
  // butuh audit trail auto-close juga, insert event di sini pakai
  // reason: "auto_recovered_chain_apply".
}

async function chainApplyFromBuffer(client, tenant_id, production_job_id) {
  // Setelah apply sukses, cek buffer apakah versi berikutnya sudah menunggu
  const nextRes = await client.query(
    `SELECT pe.sequence_version, ev.*
     FROM pending_events pe
     JOIN production_events ev ON ev.id = pe.event_id
     WHERE pe.production_job_id = $1
     ORDER BY pe.sequence_version ASC LIMIT 1`,
    [production_job_id]
  );
  if (nextRes.rowCount === 0) return;

  const row = nextRes.rows[0];
  const currentRes = await client.query(
    `SELECT current_version FROM production_jobs WHERE id = $1`,
    [production_job_id]
  );
  const lastApplied = parseInt(currentRes.rows[0]?.current_version ?? 0, 10);
  const rowSeqVersion = parseInt(row.sequence_version, 10);

  if (rowSeqVersion === lastApplied + 1) {
    await client.query(
      `DELETE FROM pending_events WHERE production_job_id = $1 AND sequence_version = $2`,
      [production_job_id, rowSeqVersion]
    );
    await tryApplyToState(client, {
      id: row.id,
      tenant_id,
      production_job_id,
      event_type: row.event_type,
      event_version: row.event_version,
      payload: row.payload,
      sequence_version: rowSeqVersion,
    });
    // tryApplyToState akan panggil chainApplyFromBuffer lagi secara rekursif
  }
}

module.exports = { tryApplyToState };
