require('dotenv').config();
const { Client } = require('pg');
const c = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: { require: true, rejectUnauthorized: false } });
c.connect()
  .then(() => c.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'ledger_conciliacion' ORDER BY ordinal_position"))
  .then(r => { console.log('ledger_conciliacion:', r.rows.map(x=>x.column_name).join(', ')); return c.end(); })
  .catch(e => { console.error(e.message); c.end(); });
