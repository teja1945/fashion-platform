require("dotenv").config();
const { ingestEvent } = require("./ingestion");
const { pool } = require("./db");

async function main() {
  const tenant_id = "8ae20661-626d-42c9-b930-6c926ca3ce99";
  const order_id = "a6f807b1-881d-4f00-bc2c-98faa5ff4b52";

  // STEP 2: gudang -> cutting
  const r2 = await ingestEvent({
    event_type: "STAGE_COMPLETED",
    tenant_id,
    order_id,
    source: "manual-test",
    request_id: "test-stage-002",
    payload: { note: "gudang selesai verifikasi" },
  });
  console.log("STEP 2 (gudang->cutting):", JSON.stringify(r2, null, 2));

  // STEP 3: cutting -> jahit
  const r3 = await ingestEvent({
    event_type: "STAGE_COMPLETED",
    tenant_id,
    order_id,
    source: "manual-test",
    request_id: "test-stage-003",
    payload: { note: "cutting selesai" },
  });
  console.log("STEP 3 (cutting->jahit):", JSON.stringify(r3, null, 2));

  // STEP 4: qc.passed (event non-stage, cuma numpang versioning, tidak pindah stage)
  const r4 = await ingestEvent({
    event_type: "qc.passed",
    tenant_id,
    order_id,
    source: "manual-test",
    request_id: "test-qc-004",
    payload: { note: "qc pass dummy" },
  });
  console.log("STEP 4 (qc.passed):", JSON.stringify(r4, null, 2));

  // STEP 5: shipment.dispatched
  const r5 = await ingestEvent({
    event_type: "shipment.dispatched",
    tenant_id,
    order_id,
    source: "manual-test",
    request_id: "test-ship-005",
    payload: { note: "dikirim dummy" },
  });
  console.log("STEP 5 (shipment.dispatched):", JSON.stringify(r5, null, 2));

  await pool.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
