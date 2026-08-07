const { pool, withTenant, getActiveTenantIds } = require("./db");

const GAP_THRESHOLD_SECONDS = 60;
const GRACE_PERIOD_SECONDS = 300;
const BATCH_LIMIT_PER_TENANT = 500;
const ADVISORY_LOCK_KEY = 771100;

let isRunning = false;

/**
 * Cek & eskalasi gap untuk SATU tenant. Dipanggil di dalam withTenant(),
 * jadi semua query di sini otomatis kefilter RLS ke tenant tsb.
 */
async function checkGapsForTenant(client, tenantId) {
  const openGaps = await client.query(
    `SELECT pj.id AS production_job_id,
            pj.gap_status,
            pj.current_version,
            oe.opened_at,
            EXTRACT(EPOCH FROM (now() - oe.opened_at)) AS age_seconds,
            EXISTS (
              SELECT 1 FROM production_events ee
              WHERE ee.production_job_id = pj.id
                AND ee.event_type = 'gap.escalated'
                AND ee.created_at > oe.opened_at
            ) AS already_escalated
     FROM production_jobs pj
     JOIN LATERAL (
       SELECT created_at AS opened_at
       FROM production_events
       WHERE production_job_id = pj.id AND event_type = 'gap.opened'
       ORDER BY created_at DESC
       LIMIT 1
     ) oe ON true
     WHERE pj.gap_status IN ('OPEN', 'RECOVERING')
     ORDER BY oe.opened_at ASC
     LIMIT $1`,
    [BATCH_LIMIT_PER_TENANT]
  );

  for (const gap of openGaps.rows) {
    const ageSeconds = Number(gap.age_seconds);

    if (gap.gap_status === "OPEN" && ageSeconds >= GAP_THRESHOLD_SECONDS) {
      console.warn(
        `[ALERT] tenant=${tenantId} job=${gap.production_job_id}: gap terbuka > ${GAP_THRESHOLD_SECONDS}s. Status -> RECOVERING.`
      );
      await client.query(
        `UPDATE production_jobs SET gap_status = 'RECOVERING', updated_at = now()
         WHERE id = $1 AND gap_status = 'OPEN'`,
        [gap.production_job_id]
      );
    }

    if (
      gap.gap_status === "RECOVERING" &&
      ageSeconds >= GAP_THRESHOLD_SECONDS + GRACE_PERIOD_SECONDS &&
      !gap.already_escalated
    ) {
      console.error(
        `[ESCALATED] tenant=${tenantId} job=${gap.production_job_id}: gagal recover otomatis. Butuh keputusan manual.`
      );
      await client.query(
        `UPDATE production_jobs SET gap_status = 'ESCALATED', updated_at = now()
         WHERE id = $1 AND gap_status = 'RECOVERING'`,
        [gap.production_job_id]
      );
      await client.query(
        `INSERT INTO production_events (tenant_id, production_job_id, event_type, event_version, payload)
         VALUES ($1, $2, 'gap.escalated', 1, $3::jsonb)`,
        [
          tenantId,
          gap.production_job_id,
          JSON.stringify({
            escalation_level: "ESCALATED",
            age_seconds: ageSeconds,
            reason: "auto_recovery_timeout",
          }),
        ]
      );
    }
  }
}

async function checkGaps() {
  if (isRunning) {
    console.warn("checkGaps() masih berjalan dari tick sebelumnya, skip tick ini.");
    return;
  }
  isRunning = true;

  const client = await pool.connect();
  client.on("error", (err) => {
    console.error("checkGaps client error:", err.message);
  });

  try {
    const lockRes = await client.query(`SELECT pg_try_advisory_lock($1) AS locked`, [ADVISORY_LOCK_KEY]);
    if (!lockRes.rows[0].locked) {
      console.warn("Instance/proses lain sedang pegang gap-monitor lock, skip tick ini.");
      return;
    }

    try {
      const tenantIds = await getActiveTenantIds(client);
      for (const tenantId of tenantIds) {
        try {
          await withTenant(client, tenantId, (c) => checkGapsForTenant(c, tenantId));
        } catch (err) {
          console.error(`checkGaps: gagal proses tenant ${tenantId}:`, err.message);
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
    isRunning = false;
  }
}

async function manuallyResolveGap(tenantId, productionJobId, resolvedBy) {
  const client = await pool.connect();
  client.on("error", (err) => {
    console.error("manuallyResolveGap client error:", err.message);
  });

  try {
    const lockRes = await client.query(`SELECT pg_try_advisory_lock($1) AS locked`, [ADVISORY_LOCK_KEY]);
    if (!lockRes.rows[0].locked) {
      console.warn(`manuallyResolveGap: lock tidak tersedia untuk job ${productionJobId}, gap-monitor sedang jalan. Coba lagi.`);
      return { resolved: false, reason: "lock_unavailable" };
    }

    try {
      return await withTenant(client, tenantId, async (c) => {
        const res = await c.query(
          `UPDATE production_jobs SET gap_status = 'CLOSED', updated_at = now()
           WHERE id = $1 AND gap_status IN ('OPEN', 'RECOVERING', 'ESCALATED')
           RETURNING id`,
          [productionJobId]
        );

        if (res.rowCount === 0) {
          console.warn(`manuallyResolveGap: job ${productionJobId} tidak dalam status yang bisa di-resolve.`);
          return { resolved: false, reason: "no_matching_gap" };
        }

        await c.query(
          `INSERT INTO production_events (tenant_id, production_job_id, event_type, event_version, payload)
           VALUES ($1, $2, 'gap.resolved', 1, $3::jsonb)`,
          [
            tenantId,
            productionJobId,
            JSON.stringify({ resolution_type: "manual_fix", resolved_by: resolvedBy }),
          ]
        );

        console.log(`Gap untuk job ${productionJobId} di-resolve manual oleh ${resolvedBy}.`);
        return { resolved: true };
      });
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

function startGapMonitor(intervalMs = 10000) {
  console.log("Gap monitor worker started.");
  setInterval(() => {
    checkGaps().catch((err) => {
      console.error("gap monitor error:", err);
      isRunning = false;
    });
  }, intervalMs);
}

// --- Bundle-split reconciler: BELUM DIADAPTASI ---
// LTOS punya reconcileBundleSplits() yang gantung ke tabel `events` dan
// `order_state` (projection per-child-bundle hasil BUNDLE_ALLOCATION).
// Tidak ada padanan tabel ini di schema v2 — konsep "1 bundle dipecah jadi
// N child" (CHECKPOINT bagian 8 & 13) belum punya desain tabel sama sekali.
// SENGAJA tidak ditulis ulang di sini sampai ada keputusan desain:
// child bundle disimpan sebagai baris production_jobs baru, atau tabel baru?
// Lihat CHECKPOINT bagian 13 "Next steps" untuk konteks lengkap.

module.exports = { startGapMonitor, checkGaps, manuallyResolveGap };
