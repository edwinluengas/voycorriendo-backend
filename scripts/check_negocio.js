require('dotenv').config();
const { Client } = require('pg');

const TELEFONO = '5545074460';

async function main() {
  const client = new Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, ssl: { require: true, rejectUnauthorized: false },
  });
  await client.connect();

  const { rows: usuarios } = await client.query('SELECT id, nombre, estado FROM usuarios WHERE telefono = $1', [TELEFONO]);
  if (!usuarios.length) { console.log('Usuario no encontrado.'); await client.end(); return; }
  const { id: uid, nombre, estado } = usuarios[0];
  console.log(`Usuario: ${nombre} (${uid}) estado=${estado}`);

  const { rows: negocios } = await client.query(
    'SELECT id, nombre, verificacion_estado, bloqueado_por_deuda, usuario_id FROM negocios WHERE usuario_id = $1',
    [uid]
  );
  console.log('Negocios encontrados:', negocios.length);
  negocios.forEach(n => console.log(` -> id=${n.id} nombre=${n.nombre} verificacion_estado=${n.verificacion_estado} bloqueado=${n.bloqueado_por_deuda}`));

  await client.end();
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
