require('dotenv').config({quiet:true});
const { pool } = require('./db');
(async () => {
  const r = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'production_jobs' ORDER BY ordinal_position"
  );
  console.log(r.rows);
  await pool.end();
})();
