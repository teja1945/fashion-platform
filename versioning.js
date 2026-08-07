const { pool, withTenant } = require("./db");
const { tryApplyToState } = require("./stateLayer");

/**
 * Jalur khusus: bikin production_jobs baru + event pertamanya. DIPAKAI HANYA
 * untuk event order.confirmed_for_production (job belum exist sebelum ini).
 * Tidak lewat tryApplyToState — job dibuat langsung di versi 1, bukan "apply"
 * ke row yang sudah ada (lihat kontrak stateLayer.js: production_jobs SELALU
 * sudah ada sebelum tryApplyToState dipanggil).
 *
 * @param {object} params
 *   tenantId, orderId, pipelineSnapshot (array dari tenant_pipeline_stages,
 *   diurutkan stage_order ASC), payload, requestId
 */
async function createProductionJob({ tenantId, orderId, pipelineSnapshot, payload, requestId }) {
  const client = await pool.connect();
  client.on("error", (err) => console.error("createProductionJob client error:", err.message));

  try {
    return await withTenant(client, tenantId, async (c) => {
      if (requestId) {
        const dedupRes = await c.query(
          `INSERT INTO request_dedup (tenant_id, request_id) VALUES ($1, $2)
           ON CONFLICT (tenant_id, request_id) DO NOTHING
           RETURNING id`,
          [tenantId, requestId]
        );
        if (dedupRes.rowCount === 0) {
          return { duplicate: true };
        }
      }

      // Lock row orders dulu + cek apakah sudah punya production_job.
      // FOR UPDATE di sini penting: kalau 2 request bersamaan coba confirm
      // order yang sama, yang kedua akan nunggu lock lalu lihat
      // production_job_id sudah keisi -> return job yang sudah ada,
      // BUKAN bikin production_jobs baru yang dobel.
      const orderLock = await c.query(
        `SELECT production_job_id FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      );
      if (orderLock.rowCount === 0) {
        throw new Error(`order ${orderId} tidak ditemukan`);
      }
      if (orderLock.rows[0].production_job_id) {
        return { alreadyExists: true, productionJobId: orderLock.rows[0].production_job_id };
      }

      if (!Array.isArray(pipelineSnapshot) || pipelineSnapshot.length === 0) {
        throw new Error("pipeline_snapshot kosong — tenant belum punya tenant_pipeline_stages");
      }
      const firstStage = pipelineSnapshot[0].stage_key;

      const jobRes = await c.query(
        `INSERT INTO production_jobs
           (tenant_id, order_id, current_stage, current_version, next_sequence_version, gap_status, pipeline_snapshot)
         VALUES ($1, $2, $3, 1, 1, 'CLOSED', $4::jsonb)
         RETURNING id`,
        [tenantId, orderId, firstStage, JSON.stringify(pipelineSnapshot)]
      );
      const productionJobId = jobRes.rows[0].id;

      const eventRes = await c.query(
        `INSERT INTO production_events
           (tenant_id, production_job_id, event_type, event_version, payload, sequence_version)
         VALUES ($1, $2, 'order.confirmed_for_production', 1, $3::jsonb, 1)
         RETURNING id`,
        [tenantId, productionJobId, JSON.stringify(payload || {})]
      );
      const eventId = eventRes.rows[0].id;

      await c.query(
        `UPDATE production_jobs SET created_from_event_id = $1 WHERE id = $2`,
        [eventId, productionJobId]
      );

      // FIX BUG KRITIS: sebelumnya kolom ini TIDAK PERNAH diupdate, jadi
      // ingestion.js (resolveProductionJobId, query ke orders.production_job_id)
      // selalu gagal nemuin job untuk SEMUA event setelah confirmation --
      // pipeline putus total di step kedua. Ini yang menyambungkannya.
      await c.query(
        `UPDATE orders SET production_job_id = $1, status = 'in_production', updated_at = now() WHERE id = $2`,
        [productionJobId, orderId]
      );

      if (requestId) {
        await c.query(
          `UPDATE request_dedup SET event_id = $1 WHERE tenant_id = $2 AND request_id = $3`,
          [eventId, tenantId, requestId]
        );
      }

      return { productionJobId, eventId, sequenceVersion: 1 };
    });
  } finally {
    client.release();
  }
}

/**
 * Jalur umum: assign sequence_version berikutnya untuk production_job yang
 * SUDAH ADA, insert event, lalu apply ke state -- semua atomik dalam 1
 * transaction (FOR UPDATE lock mencegah race antar-request bersamaan).
 *
 * @param {object} params
 *   tenantId, productionJobId, eventType, eventVersion, payload, requestId
 */
async function assignVersionAndStore({ tenantId, productionJobId, eventType, eventVersion, payload, requestId }) {
  const client = await pool.connect();
  client.on("error", (err) => console.error("assignVersionAndStore client error:", err.message));

  try {
    return await withTenant(client, tenantId, async (c) => {
      if (requestId) {
        const dedupRes = await c.query(
          `INSERT INTO request_dedup (tenant_id, request_id) VALUES ($1, $2)
           ON CONFLICT (tenant_id, request_id) DO NOTHING
           RETURNING id`,
          [tenantId, requestId]
        );
        if (dedupRes.rowCount === 0) {
          return { duplicate: true };
        }
      }

      const lockRes = await c.query(
        `SELECT next_sequence_version FROM production_jobs WHERE id = $1 FOR UPDATE`,
        [productionJobId]
      );
      if (lockRes.rowCount === 0) {
        throw new Error(`production_job ${productionJobId} tidak ditemukan`);
      }
      const sequenceVersion = parseInt(lockRes.rows[0].next_sequence_version, 10) + 1;

      const eventRes = await c.query(
        `INSERT INTO production_events
           (tenant_id, production_job_id, event_type, event_version, payload, sequence_version)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING id`,
        [tenantId, productionJobId, eventType, eventVersion || 1, JSON.stringify(payload || {}), sequenceVersion]
      );
      const eventId = eventRes.rows[0].id;

      await c.query(
        `UPDATE production_jobs SET next_sequence_version = $1 WHERE id = $2`,
        [sequenceVersion, productionJobId]
      );

      if (requestId) {
        await c.query(
          `UPDATE request_dedup SET event_id = $1 WHERE tenant_id = $2 AND request_id = $3`,
          [eventId, tenantId, requestId]
        );
      }

      const applyResult = await tryApplyToState(c, {
        id: eventId,
        tenant_id: tenantId,
        production_job_id: productionJobId,
        event_type: eventType,
        event_version: eventVersion || 1,
        payload,
        sequence_version: sequenceVersion,
      });

      return { eventId, sequenceVersion, applied: applyResult.applied };
    });
  } finally {
    client.release();
  }
}

module.exports = { createProductionJob, assignVersionAndStore };
