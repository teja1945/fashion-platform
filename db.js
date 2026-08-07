require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://localhost:5432/ltos",
  query_timeout: 15000,
  connectionTimeoutMillis: 15000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client di pool:", err.message);
});

async function getActiveTenantIds(client) {
  const res = await client.query(`SELECT * FROM list_active_tenant_ids()`);
  return res.rows.map((r) => r.id);
}

async function withTenant(client, tenantId, fn) {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

module.exports = { pool, withTenant, getActiveTenantIds };
