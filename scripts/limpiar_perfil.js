require('dotenv').config();
const { Client } = require('pg');

const TELEFONO = '5545074460';

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

  // 1. Negocio y sus dependencias
  const { rows: negocios } = await client.query('SELECT id FROM negocios WHERE usuario_id = $1', [uid]);
  for (const neg of negocios) {
    const nid = neg.id;
    await client.query('DELETE FROM restaurant_tokens WHERE restaurant_id = $1', [nid]);
    await client.query('DELETE FROM productos WHERE negocio_id = $1', [nid]);
    // pedidos del negocio
    const { rows: pedidosNeg } = await client.query('SELECT id FROM pedidos WHERE negocio_id = $1', [nid]);
    for (const p of pedidosNeg) {
      await client.query('DELETE FROM ledger_conciliacion WHERE pedido_id = $1', [p.id]);
      await client.query('DELETE FROM calificaciones WHERE pedido_id = $1', [p.id]);
    }
    await client.query('DELETE FROM pedidos WHERE negocio_id = $1', [nid]);
    await client.query('DELETE FROM negocios WHERE id = $1', [nid]);
    console.log(`[OK] Negocio ${nid} y dependencias eliminados`);
  }

  // 2. Repartidor y sus dependencias
  const { rows: repartidores } = await client.query('SELECT id FROM repartidores WHERE usuario_id = $1', [uid]);
  for (const rep of repartidores) {
    const rid = rep.id;
    await client.query('DELETE FROM fondo_repartidor WHERE repartidor_id = $1', [rid]);
    // pedidos donde es repartidor
    const { rows: pedidosRep } = await client.query('SELECT id FROM pedidos WHERE repartidor_id = $1', [rid]);
    for (const p of pedidosRep) {
      await client.query('DELETE FROM calificaciones WHERE pedido_id = $1', [p.id]);
    }
    await client.query('DELETE FROM pedidos WHERE repartidor_id = $1', [rid]);
    await client.query('DELETE FROM repartidores WHERE id = $1', [rid]);
    console.log(`[OK] Repartidor ${rid} y dependencias eliminados`);
  }

  // 3. Pedidos como cliente
  const { rows: pedidosCliente } = await client.query('SELECT id FROM pedidos WHERE cliente_id = $1', [uid]);
  for (const p of pedidosCliente) {
    await client.query('DELETE FROM ledger_conciliacion WHERE pedido_id = $1', [p.id]);
    await client.query('DELETE FROM calificaciones WHERE pedido_id = $1', [p.id]);
  }
  await client.query('DELETE FROM pedidos WHERE cliente_id = $1', [uid]);
  console.log(`[OK] ${pedidosCliente.length} pedido(s) de cliente eliminados`);

  // 4. Usuario
  await client.query('DELETE FROM usuarios WHERE id = $1', [uid]);
  console.log(`[OK] Usuario ${uid} eliminado`);

  await client.end();
  console.log('\n✅ Perfil limpio. El numero puede registrarse de cero.');
}

main().catch((e) => { console.error('[ERROR]', e.message); process.exit(1); });
