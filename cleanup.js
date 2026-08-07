require('dotenv').config({quiet:true});
const { pool, withTenant } = require('./db');
(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenant(client, '8ae20661-626d-42c9-b930-6c926ca3ce99', async (c) => {
      const p = await c.query(
        `DELETE FROM pending_events WHERE event_id IN (
           SELECT id FROM production_events WHERE production_job_id = $1 AND sequence_version IN (6,7)
         ) RETURNING id, event_id`,
        ['25352257-4cff-4377-85d7-2a63b05146fe']
      );
      console.log('Deleted from pending_events:', p.rows);

      const r = await c.query(
        "DELETE FROM production_events WHERE production_job_id = $1 AND sequence_version IN (6,7) RETURNING id, sequence_version",
        ['25352257-4cff-4377-85d7-2a63b05146fe']
      );
      console.log('Deleted from production_events:', r.rows);
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('CLEANUP ERROR:', err);
  } finally {
    client.release();
    await pool.end();
  }
})();
