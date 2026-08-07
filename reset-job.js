require('dotenv').config({quiet:true});
const { pool, withTenant } = require('./db');
(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenant(client, '8ae20661-626d-42c9-b930-6c926ca3ce99', async (c) => {
      const r = await c.query(
        `UPDATE production_jobs SET
           current_version = 5,
           current_stage = 'jahit',
           gap_status = 'CLOSED',
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        ['25352257-4cff-4377-85d7-2a63b05146fe']
      );
      console.log(JSON.stringify(r.rows[0], null, 2));
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('RESET ERROR:', err);
  } finally {
    client.release();
    await pool.end();
  }
})();
