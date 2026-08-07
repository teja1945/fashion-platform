require("dotenv").config();
const { ingestEvent } = require("./ingestion");
const { pool } = require("./db");

async function main() {
  const tenant_id = "8ae20661-626d-42c9-b930-6c926ca3ce99";
  const order_id = "a6f807b1-881d-4f00-bc2c-98faa5ff4b52";

  const r1 = await ingestEvent({
    event_type: "order.confirmed_for_production",
    tenant_id,
    order_id,
    source: "manual-test",
    request_id: "test-confirm-001",
    payload: { note: "e2e test" },
  });
  console.log("STEP 1 result:", JSON.stringify(r1, null, 2));

  await pool.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
