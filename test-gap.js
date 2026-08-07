require("dotenv").config();
const { pool, withTenant } = require("./db");
const { tryApplyToState } = require("./stateLayer");

const TENANT_ID = "8ae20661-626d-42c9-b930-6c926ca3ce99";
const JOB_ID = "25352257-4cff-4377-85d7-2a63b05146fe";

async function insertEvent(client, seq, type, payload) {
  const res = await client.query(
    `INSERT INTO production_events (tenant_id, production_job_id, event_type, event_version, payload, sequence_version)
     VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`,
    [TENANT_ID, JOB_ID, type, JSON.stringify(payload), seq]
  );
  return res.rows[0].id;
}

async function apply(client, seq, type, payload) {
  const id = await insertEvent(client, seq, type, payload);
  const r = await tryApplyToState(client, { id, tenant_id: TENANT_ID, production_job_id: JOB_ID, event_type: type, event_version: 1, payload, sequence_version: seq });
  console.log(`Event seq ${seq} (${type}):`, r);
}

async function status(label) {
  const client = await pool.connect();
  await client.query(`SET app.tenant_id = '${TENANT_ID}'`);
  const r = await client.query(`SELECT current_version, gap_status, current_stage FROM production_jobs WHERE id = $1`, [JOB_ID]);
  console.log(label, r.rows[0]);
  client.release();
}

async function main() {
  await status("Status awal:");

  let client = await pool.connect();
  await client.query("BEGIN");
  await withTenant(client, TENANT_ID, (c) => apply(c, 9, "qc.passed", {}));
  await client.query("COMMIT");
  client.release();
  await status("Setelah seq 9 (lompat, harus jadi gap):");

  client = await pool.connect();
  await client.query("BEGIN");
  await withTenant(client, TENANT_ID, (c) => apply(c, 7, "order.stage_changed", { to_stage: "qc" }));
  await client.query("COMMIT");
  client.release();
  await status("Setelah seq 7 susulan:");

  client = await pool.connect();
  await client.query("BEGIN");
  await withTenant(client, TENANT_ID, (c) => apply(c, 8, "order.stage_changed", { to_stage: "packing" }));
  await client.query("COMMIT");
  client.release();
  await status("FINAL setelah seq 8 (expect current_version=9, gap_status=CLOSED):");

  await pool.end();
}

main().catch((err) => {
  console.error("TEST ERROR:", err);
  process.exit(1);
});
