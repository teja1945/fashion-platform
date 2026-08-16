const { pool, withTenant } = require("./db");
const { createProductionJob, assignVersionAndStore } = require("./versioning");

const KNOWN_EVENT_TYPES = new Set([
  "order.confirmed_for_production",
  "order.updated",
  "order.cancelled",
  "order.stage_changed",
  "payment.initiated",
  "payment.received",
  "payment.failed",
  "qc.passed",
  "qc.failed",
  "shipment.dispatched",
  "shipment.delivered",
  "STAGE_COMPLETED",
  "STAGE_REJECTED",
  "BUNDLE_ALLOCATION",
]);

const rateBuckets = new Map();
const RATE_LIMIT_PER_SEC = 1000;

function checkRateLimit(source) {
  const now = Math.floor(Date.now() / 1000);
  const key = `${source}:${now}`;
  const count = (rateBuckets.get(key) || 0) + 1;
  rateBuckets.set(key, count);
  if (rateBuckets.size > 10000) rateBuckets.clear();
  return count <= RATE_LIMIT_PER_SEC;
}

function validateEvent(body) {
  const errors = [];
  if (!body.event_type || !KNOWN_EVENT_TYPES.has(body.event_type)) {
    errors.push(`event_type tidak dikenal: ${body.event_type}`);
  }
  if (!body.tenant_id || typeof body.tenant_id !== "string") {
    errors.push("tenant_id wajib string");
  }
  if (!body.order_id || typeof body.order_id !== "string") {
    errors.push("order_id wajib string");
  }
  if (!body.source || typeof body.source !== "string") {
    errors.push("source wajib string");
  }
  if (!body.payload || typeof body.payload !== "object") {
    errors.push("payload wajib object");
  }
  return errors;
}

function resolveStageTransition(pipelineSnapshot, currentStage, eventType, payload) {
  const stageKeys = pipelineSnapshot.map((s) => s.stage_key);
  const currentIndex = stageKeys.indexOf(currentStage);
  if (currentIndex === -1) {
    return { error: `stage tidak ditemukan di pipeline_snapshot: ${currentStage}` };
  }

  if (eventType === "STAGE_COMPLETED") {
    if (currentIndex >= stageKeys.length - 1) {
      return { error: "job sudah di stage terakhir, tidak bisa maju lagi" };
    }
    return { stage: stageKeys[currentIndex + 1] };
  }

  if (eventType === "STAGE_REJECTED") {
    const targetStage = payload && payload.target_stage;
    if (!targetStage || typeof targetStage !== "string") {
      return { error: "target_stage wajib diisi untuk reject" };
    }
    const targetIndex = stageKeys.indexOf(targetStage);
    if (targetIndex === -1) {
      return { error: `target_stage tidak ditemukan di pipeline_snapshot: ${targetStage}` };
    }
    if (targetIndex >= currentIndex) {
      return { error: "target_stage reject harus stage SEBELUM stage saat ini" };
    }
    const reason = payload && payload.reason;
    if (!reason || typeof reason !== "string" || reason.trim() === "") {
      return { error: "reason wajib diisi untuk reject" };
    }
    return { stage: targetStage };
  }

  return { error: `event_type tidak didukung untuk stage transition: ${eventType}` };
}

async function resolveProductionJobId(client, orderId) {
  const res = await client.query(
    `SELECT production_job_id FROM orders WHERE id = $1`,
    [orderId]
  );
  if (res.rowCount === 0) {
    return { error: "order_id tidak ditemukan" };
  }
  if (!res.rows[0].production_job_id) {
    return { error: "order ini belum punya production_job (belum confirmed_for_production)" };
  }
  return { productionJobId: res.rows[0].production_job_id };
}

async function ingestEvent(body) {
  if (!checkRateLimit(body.source || "unknown")) {
    return { httpStatus: 429, body: { error: "rate limit exceeded" } };
  }

  const errors = validateEvent(body);
  if (errors.length > 0) {
    return { httpStatus: 400, body: { error: "validation failed", details: errors } };
  }

  const { tenant_id, order_id, event_type, payload, source, request_id } = body;

  if (event_type === "BUNDLE_ALLOCATION") {
    return {
      httpStatus: 501,
      body: { error: "BUNDLE_ALLOCATION belum didukung di schema v2 — nunggu keputusan desain child bundle (lihat CHECKPOINT bagian 13/31/33)" },
    };
  }

  if (event_type === "order.confirmed_for_production") {
    const client = await pool.connect();
    client.on("error", (err) => console.error("ingestEvent client error:", err.message));

    let pipelineRows;
    try {
      const pipelineRes = await withTenant(client, tenant_id, (c) =>
        c.query(
          `SELECT stage_key, stage_order, is_gudang_stage, is_optional
           FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC`,
          [tenant_id]
        )
      );
      pipelineRows = pipelineRes.rows;
    } finally {
      client.release();
    }

    if (pipelineRows.length === 0) {
      return { httpStatus: 422, body: { error: "tenant belum punya tenant_pipeline_stages, tidak bisa bikin production_job" } };
    }

    try {
      const result = await createProductionJob({
        tenantId: tenant_id,
        orderId: order_id,
        pipelineSnapshot: pipelineRows,
        payload,
        requestId: request_id,
      });
      if (result.duplicate) {
        return { httpStatus: 200, body: { status: "duplicate_request", request_id } };
      }
      return { httpStatus: 201, body: result };
    } catch (err) {
      console.error("createProductionJob gagal:", err.message);
      return { httpStatus: 500, body: { error: "gagal membuat production_job" } };
    }
  }

  const client = await pool.connect();
  client.on("error", (err) => console.error("ingestEvent client error:", err.message));

  let productionJobId, currentStage, pipelineSnapshot;
  try {
    const resolved = await withTenant(client, tenant_id, async (c) => {
      const r = await resolveProductionJobId(c, order_id);
      if (r.error) return r;

      const jobRes = await c.query(
        `SELECT current_stage, pipeline_snapshot FROM production_jobs WHERE id = $1`,
        [r.productionJobId]
      );
      if (jobRes.rowCount === 0) {
        return { error: "production_job tidak ditemukan" };
      }
      return {
        productionJobId: r.productionJobId,
        currentStage: jobRes.rows[0].current_stage,
        pipelineSnapshot: jobRes.rows[0].pipeline_snapshot,
      };
    });

    if (resolved.error) {
      return { httpStatus: 404, body: { error: resolved.error } };
    }
    ({ productionJobId, currentStage, pipelineSnapshot } = resolved);
  } finally {
    client.release();
  }

  let finalPayload = payload;

  if (event_type === "STAGE_COMPLETED" || event_type === "STAGE_REJECTED") {
    const resolution = resolveStageTransition(pipelineSnapshot, currentStage, event_type, payload);
    if (resolution.error) {
      return { httpStatus: 400, body: { error: resolution.error } };
    }
    finalPayload = { ...payload, to_stage: resolution.stage };
  }

  try {
    const result = await assignVersionAndStore({
      tenantId: tenant_id,
      productionJobId,
      eventType: event_type === "STAGE_COMPLETED" || event_type === "STAGE_REJECTED" ? "order.stage_changed" : event_type,
      eventVersion: 1,
      payload: finalPayload,
      requestId: request_id,
    });

    if (result.duplicate) {
      return { httpStatus: 200, body: { status: "duplicate_request", request_id } };
    }
    return { httpStatus: 201, body: result };
  } catch (err) {
    console.error("assignVersionAndStore gagal:", err.message);
    return { httpStatus: 500, body: { error: "gagal menyimpan event" } };
  }
}

module.exports = { ingestEvent, KNOWN_EVENT_TYPES, resolveStageTransition };
