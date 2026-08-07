require('dotenv').config({quiet:true});
const { pool, withTenant } = require('./db');
(async () => {
  const client = await pool.connect();
  try {
    await withTenant(client, '8ae20661-626d-42c9-b930-6c926ca3ce99', async (c) => {
      const r = await c.query(
        "SELECT sequence_version, event_type, payload FROM production_events WHERE production_job_id = $1 ORDER BY sequence_version",
        ['25352257-4cff-4377-85d7-2a63b05146fe']
      );
      console.log(JSON.stringify(r.rows, null, 2));
    });
  } finally {
    client.release();
    await pool.end();
  }
})();
