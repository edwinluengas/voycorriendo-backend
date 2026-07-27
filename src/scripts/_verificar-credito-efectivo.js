/**
 * Verificación end-to-end del fix de "crédito en pedido EN EFECTIVO":
 * el repartidor le paga al restaurante el subtotal completo pero solo cobra
 * el neto al cliente, así que la plataforma debe abonarle el crédito a su
 * fondo. Antes ese dinero salía de su bolsillo.
 *
 * Corre contra el servidor local (TEST_BASE_URL) con las cuentas de prueba.
 * Revierte TODO al final: pedido, ledger, deuda del negocio y fondo.
 */
require('dotenv').config();
const axios = require('axios');
const https = require('https');
const { sequelize } = require('../config/database');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3999') + '/api';
const api = axios.create({
  baseURL: BASE,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  validateStatus: () => true,
});
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const CUENTAS = {
  admin:      { telefono: '0000000001', password: 'VoyTest2026!' },
  cliente:    { telefono: '0000000002', password: 'VoyTest2026!' },
  negocio:    { telefono: '0000000003', password: 'VoyTest2026!' },
  repartidor: { telefono: '0000000004', password: 'VoyTest2026!' },
};
const NEGOCIO = '33333333-0000-0000-0000-000000000001';
const PRODUCTO = '36f7d479-f8c6-484e-9999-7e5561fc78fe'; // $22
const DESTINO = { lat: 15.8650, lng: -97.0700 };
const CREDITO = 50;

const login = async (rol) => {
  const r = await api.post('/auth/login', CUENTAS[rol]);
  if (!r.data?.ok) throw new Error(`login ${rol}: ${JSON.stringify(r.data)}`);
  return { token: r.data.data.token, usuario: r.data.data.usuario };
};
const q = (sql, rep) => sequelize.query(sql, { type: sequelize.QueryTypes.SELECT, replacements: rep });

(async () => {
  const admin = await login('admin');
  const cliente = await login('cliente');
  const negocio = await login('negocio');
  const repartidor = await login('repartidor');

  const [{ id: repId }] = await q(`SELECT id FROM repartidores WHERE usuario_id = :u`, { u: repartidor.usuario.id });
  const fondoAntes = (await q(`SELECT monto_disponible FROM fondo_repartidor WHERE repartidor_id = :r`, { r: repId }))[0];
  const antes = parseFloat(fondoAntes?.monto_disponible || 0);
  console.log('Fondo del repartidor ANTES:', antes);

  // 1. Admin le da crédito al cliente
  const cred = await api.post(`/admin/usuarios/${cliente.usuario.id}/creditos`,
    { monto: CREDITO, motivo: 'Prueba automatizada del abono de crédito en efectivo' }, auth(admin.token));
  if (!cred.data?.ok) throw new Error(`otorgar crédito: ${JSON.stringify(cred.data)}`);
  console.log('Crédito otorgado:', CREDITO);

  // 2. Cliente crea pedido EN EFECTIVO usando su crédito
  const pedidoRes = await api.post('/pedidos', {
    negocio_id: NEGOCIO,
    items: [{ producto_id: PRODUCTO, cantidad: 8 }],   // $176 > pedido mínimo
    metodo_pago: 'efectivo',
    direccion_entrega: 'Prueba automatizada — crédito en efectivo',
    latitud_entrega: DESTINO.lat, longitud_entrega: DESTINO.lng,
    tipo_envio: 'standard',
    usar_credito: true,
  }, auth(cliente.token));
  if (!pedidoRes.data?.ok) throw new Error(`crear pedido: ${JSON.stringify(pedidoRes.data)}`);
  const pedido = pedidoRes.data.data.pedido;
  console.log(`Pedido ${pedido.numero}: total $${pedido.total}, crédito aplicado $${pedido.credito_aplicado}`);

  // 3. Negocio confirma → preparando → listo
  for (const estado of ['confirmado', 'preparando', 'listo']) {
    const r = await api.patch(`/pedidos/${pedido.id}/estado`, { estado }, auth(negocio.token));
    if (!r.data?.ok) throw new Error(`${estado}: ${JSON.stringify(r.data)}`);
  }

  // 4. Repartidor acepta y entrega
  const acep = await api.post('/repartidores/aceptar-pedido', { pedido_id: pedido.id }, auth(repartidor.token));
  if (!acep.data?.ok) throw new Error(`aceptar: ${JSON.stringify(acep.data)}`);
  const [{ codigo_entrega }] = await q(`SELECT codigo_entrega FROM pedidos WHERE id = :id`, { id: pedido.id });
  const ent = await api.patch(`/pedidos/${pedido.id}/estado`,
    { estado: 'entregado', codigo_entrega }, auth(repartidor.token));
  if (!ent.data?.ok) throw new Error(`entregar: ${JSON.stringify(ent.data)}`);

  // 5. Verificación
  const [fondoDespues] = await q(`SELECT monto_disponible FROM fondo_repartidor WHERE repartidor_id = :r`, { r: repId });
  const despues = parseFloat(fondoDespues?.monto_disponible || 0);
  const delta = Math.round((despues - antes) * 100) / 100;
  const creditoAplicado = parseFloat(pedido.credito_aplicado);
  console.log('Fondo DESPUÉS:', despues, '| diferencia:', delta, '| crédito aplicado:', creditoAplicado);
  const ok = delta === creditoAplicado;
  console.log(ok
    ? `✅ CORRECTO: se le abonaron los $${creditoAplicado} que no cobró en efectivo.`
    : `❌ FALLA: esperaba +$${creditoAplicado} en el fondo, se movió $${delta}.`);

  // 6. Limpieza — revierte todo efecto económico de la prueba
  await sequelize.query(`DELETE FROM ledger_conciliacion WHERE pedido_id = :id`, { replacements: { id: pedido.id } });
  await sequelize.query(`DELETE FROM platform_revenue WHERE order_id = :id`, { replacements: { id: pedido.id } });
  await sequelize.query(`DELETE FROM pedidos WHERE id = :id`, { replacements: { id: pedido.id } });
  await sequelize.query(`UPDATE negocios SET deuda_plataforma = GREATEST(0, deuda_plataforma - 35),
      pedidos_efectivo_pendientes = GREATEST(0, pedidos_efectivo_pendientes - 1) WHERE id = :n`, { replacements: { n: NEGOCIO } });
  await sequelize.query(`UPDATE fondo_repartidor SET monto_disponible = :m WHERE repartidor_id = :r`, { replacements: { m: antes, r: repId } });
  await sequelize.query(`DELETE FROM creditos_cliente WHERE usuario_id = :u AND motivo LIKE 'Prueba automatizada%'`, { replacements: { u: cliente.usuario.id } });
  await sequelize.query(`UPDATE usuarios SET credito_disponible = 0 WHERE id = :u`, { replacements: { u: cliente.usuario.id } });
  await sequelize.query(`UPDATE delivery_batches SET status='completed', completed_at=NOW()
     WHERE status='active' AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.batch_id = delivery_batches.id AND p.estado NOT IN ('entregado','cancelado','rechazado'))`);
  console.log('Limpieza hecha (pedido, ledger, deuda, fondo y crédito revertidos).');

  await sequelize.close();
  process.exit(ok ? 0 : 1);
})().catch(async (e) => { console.error('ERROR:', e.message); try { await sequelize.close(); } catch (_) {} process.exit(1); });
