/**
 * SOLO LECTURA — lista usuarios/negocios/repartidores creados desde ayer
 * para decidir qué se borra. No modifica nada.
 */
require('dotenv').config();
const { sequelize } = require('../config/database');

(async () => {
  const q = (sql) => sequelize.query(sql, { type: sequelize.QueryTypes.SELECT });
  const desde = `(NOW() AT TIME ZONE 'America/Mexico_City')::date - INTERVAL '1 day'`;

  const usuarios = await q(`
    SELECT u.id, u.nombre, u.apellido, u.telefono, u.email, u.rol, u.credito_disponible, u.creado_en,
           (SELECT COUNT(*) FROM pedidos p WHERE p.cliente_id = u.id) AS pedidos_cliente,
           (SELECT COUNT(*) FROM negocios n WHERE n.usuario_id = u.id) AS negocios,
           (SELECT COUNT(*) FROM repartidores r WHERE r.usuario_id = u.id) AS repartidores
    FROM usuarios u WHERE u.creado_en >= ${desde} ORDER BY u.creado_en`);

  const negocios = await q(`
    SELECT n.id, n.nombre, n.categoria, n.usuario_id, n.creado_en, n.verificacion_estado,
           n.deuda_plataforma, n.pedidos_efectivo_pendientes,
           (SELECT COUNT(*) FROM pedidos p WHERE p.negocio_id = n.id) AS pedidos,
           (SELECT COUNT(*) FROM productos pr WHERE pr.negocio_id = n.id) AS productos
    FROM negocios n WHERE n.creado_en >= ${desde} ORDER BY n.creado_en`);

  const repartidores = await q(`
    SELECT r.id, r.usuario_id, r.tipo_vehiculo, r.placa_vehiculo, r.creado_en, r.verificacion_estado,
           (SELECT COUNT(*) FROM pedidos p WHERE p.repartidor_id = r.id) AS pedidos
    FROM repartidores r WHERE r.creado_en >= ${desde} ORDER BY r.creado_en`);

  const pedidosRecientes = await q(`
    SELECT p.numero, p.estado, p.metodo_pago, p.pago_estado, p.total, p.creado_en
    FROM pedidos p WHERE p.creado_en >= ${desde} ORDER BY p.creado_en`);

  const totales = await q(`
    SELECT (SELECT COUNT(*) FROM usuarios) usuarios, (SELECT COUNT(*) FROM negocios) negocios,
           (SELECT COUNT(*) FROM repartidores) repartidores, (SELECT COUNT(*) FROM pedidos) pedidos`);

  console.log('=== USUARIOS creados desde ayer ===');
  usuarios.forEach((u) => console.log(
    `${u.creado_en.toISOString()} | ${u.telefono} | ${u.nombre} ${u.apellido || ''} | rol=${u.rol} | email=${u.email || '-'} | credito=${u.credito_disponible} | pedidos=${u.pedidos_cliente} neg=${u.negocios} rep=${u.repartidores} | ${u.id}`));
  console.log('\n=== NEGOCIOS creados desde ayer ===');
  negocios.forEach((n) => console.log(
    `${n.creado_en.toISOString()} | ${n.nombre} | ${n.categoria} | ${n.verificacion_estado} | pedidos=${n.pedidos} productos=${n.productos} deuda=${n.deuda_plataforma} | ${n.id}`));
  console.log('\n=== REPARTIDORES creados desde ayer ===');
  repartidores.forEach((r) => console.log(
    `${r.creado_en.toISOString()} | veh=${r.tipo_vehiculo} placa=${r.placa_vehiculo} | ${r.verificacion_estado} | pedidos=${r.pedidos} | ${r.id}`));
  console.log('\n=== PEDIDOS creados desde ayer ===');
  pedidosRecientes.forEach((p) => console.log(
    `${p.creado_en.toISOString()} | ${p.numero} | ${p.estado} | ${p.metodo_pago}/${p.pago_estado} | $${p.total}`));
  console.log('\n=== TOTALES EN DB ===');
  console.log(totales[0]);
  await sequelize.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
