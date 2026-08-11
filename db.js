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

// Pastikan tiap koneksi baru dari pool bisa manggil fungsi pgcrypto
// (crypt(), dst) tanpa perlu schema-qualify manual di tiap query --
// extension pgcrypto/citext ada di schema "extensions", bukan "public"
// (lihat CHECKPOINT bagian 30). ALTER ROLE app_user SET search_path
// saja tidak selalu cukup kalau koneksi lewat Session Pooler reuse
// backend yang sudah login sebelum ALTER ROLE dijalankan, jadi di-set
// eksplisit di sini biar selalu konsisten apapun kondisi pooler-nya.
pool.on("connect", (client) => {
  client.query("SET search_path TO public, extensions").catch((err) => {
    console.error("Gagal set search_path di koneksi baru:", err.message);
  });
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

// Sama seperti withTenant(), tapi juga set app.staff_id -- dipakai
// khusus endpoint yang butuh RLS cek "staff ini termasuk pihak
// terlibat" (misal ruang diskusi discrepancy), bukan cuma isolasi
// tenant biasa. Endpoint lama yang pakai withTenant() biasa TIDAK
// terpengaruh -- app.staff_id mereka otomatis kosong/NULL, jadi
// policy yang cek staff_id fail-closed (aman by default), bukan
// fail-open.
async function withTenantAndStaff(client, tenantId, staffId, fn) {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.staff_id', $1, true)`, [staffId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

module.exports = { pool, withTenant, withTenantAndStaff, getActiveTenantIds };
