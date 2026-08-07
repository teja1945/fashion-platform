require('dotenv').config({quiet:true});
const { pool, withTenant } = require('./db');
(async () => {
  const client = await pool.connect();
  try {
    await withTenant(client, '8ae20661-626d-42c9-b930-6c926ca3ce99', async (c) => {
      const r = await c.query(
        "SELECT current_version, gap_status, current_stage FROM production_jobs WHERE id = $1",
        ['25352257-4cff-4377-85d7-2a63b05146fe']
      );
      console.log(r.rows[0]);
    });
  } finally {
    client.release();
    await pool.end();
  }
})();
