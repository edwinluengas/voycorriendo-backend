require('dotenv').config();
const { Client } = require('pg');

const TELEFONO = process.argv[2] || '5545074460';

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { require: true, rejectUnauthorized: false },
  });

  await client.connect();
  console.log('[DB] Conectado');

  const { rows: usuarios } = await client.query(
    'SELECT id, nombre, rol FROM usuarios WHERE telefono = $1',
    [TELEFONO]
  );

  if (usuarios.length === 0) {
    console.log('No se encontro usuario con ese telefono.');
    await client.end();
    return;
  }

  const usuario = usuarios[0];
  const uid = usuario.id;
  console.log(`[INFO] Usuario encontrado: id=${uid} nombre=${usuario.nombre} rol=${usuario.rol}`);

  const { rows: negocios } = await client.query('SELECT id FROM negocios WHERE usuario_id = $1', [uid]);
  const { rows: repartidores } = await client.query('SELECT id FROM repartidores WHERE usuario_id = $1', [uid]);

  const pedidoIds = new Set();

  const { rows: pedidosCliente } = await client.query('SELECT id FROM pedidos WHERE cliente_id = $1', [uid]);
  pedidosCliente.forEach((p) => pedidoIds.add(p.id));

  for (const neg of negocios) {
    const { rows } = await client.query('SELECT id FROM pedidos WHERE negocio_id = $1', [neg.id]);
    rows.forEach((p) => pedidoIds.add(p.id));
  }

  for (const rep of repartidores) {
    const { rows } = await client.query('SELECT id FROM pedidos WHERE repartidor_id = $1', [rep.id]);
    rows.forEach((p) => pedidoIds.add(p.id));
  }

  console.log(`[INFO] ${pedidoIds.size} pedido(s) encontrados (cliente + negocio + repartidor)`);

  for (const pid of pedidoIds) {
    await client.query('DELETE FROM ledger_conciliacion WHERE pedido_id = $1', [pid]);
  }

  if (pedidoIds.size > 0) {
    await client.query('DELETE FROM pedidos WHERE id = ANY($1::uuid[])', [Array.from(pedidoIds)]);
  }

  console.log(`[OK] ${pedidoIds.size} pedido(s) eliminados. Perfil (usuario/negocio/repartidor) intacto.`);

  await client.end();
}

main().catch((e) => { console.error('[ERROR]', e.message); process.exit(1); });
