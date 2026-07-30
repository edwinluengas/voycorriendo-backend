/**
 * Auditoría de flujo y vulnerabilidades — fase de prueba real.
 * Prueba, contra el servidor de verdad, los caminos que un atacante o un
 * cliente listo intentaría, y los flujos completos de negocio.
 * No deja basura: borra los pedidos que crea y revierte los efectos.
 */
require('dotenv').config();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../config/database');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3999') + '/api';
const api = axios.create({ baseURL: BASE, validateStatus: () => true, timeout: 25000 });
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
const q = (s, r) => sequelize.query(s, { type: sequelize.QueryTypes.SELECT, replacements: r });

const NEGOCIO = '33333333-0000-0000-0000-000000000001';
const NEGOCIO2 = '33333333-0000-0000-0000-000000000002';
const PROD = '36f7d479-f8c6-484e-9999-7e5561fc78fe';   // $22
const DESTINO = { lat: 15.8650, lng: -97.0700 };
const creados = [];

let n = 0, malos = 0;
const check = (ok, titulo, detalle = '') => {
  n++; if (!ok) malos++;
  console.log(`${ok ? '✅' : '❌'} ${titulo}${detalle ? ' · ' + String(detalle).slice(0, 110) : ''}`);
};

const login = async (tel, pass = 'VoyTest2026!') => {
  const r = await api.post('/auth/login', { telefono: tel, password: pass });
  return { token: r.data?.data?.token, usuario: r.data?.data?.usuario, raw: r.data };
};

const pedir = (token, extra = {}) => api.post('/pedidos', {
  negocio_id: NEGOCIO,
  items: [{ producto_id: PROD, cantidad: 8 }],
  metodo_pago: 'efectivo',
  direccion_entrega: 'Auditoría automatizada — ignorar',
  latitud_entrega: DESTINO.lat, longitud_entrega: DESTINO.lng,
  tipo_envio: 'standard',
  ...extra,
}, auth(token));

(async () => {
  const cliente = await login('0000000002');
  const negocio = await login('0000000003');
  const repartidor = await login('0000000004');
  if (!cliente.token || !negocio.token || !repartidor.token) throw new Error('No se pudo iniciar sesión con las cuentas de prueba');

  console.log('\n── 1. INTEGRIDAD DE PRECIOS Y CANTIDADES ──');
  const precioFalso = await pedir(cliente.token, {
    items: [{ producto_id: PROD, cantidad: 8, precio_unitario: 1, subtotal: 8 }],
  });
  const pedidoPrecio = precioFalso.data?.data?.pedido;
  if (pedidoPrecio) creados.push(pedidoPrecio.id);
  check(pedidoPrecio && parseFloat(pedidoPrecio.subtotal) === 176,
    'Un precio enviado por el cliente se IGNORA (se usa el de la base)',
    pedidoPrecio ? `subtotal $${pedidoPrecio.subtotal}` : precioFalso.data?.mensaje);

  const cantNegativa = await pedir(cliente.token, { items: [{ producto_id: PROD, cantidad: -5 }] });
  check(cantNegativa.status === 400, 'Cantidad negativa rechazada', cantNegativa.data?.mensaje);

  const cantEnorme = await pedir(cliente.token, { items: [{ producto_id: PROD, cantidad: 99999 }] });
  check(cantEnorme.status === 400, 'Cantidad absurda rechazada', cantEnorme.data?.mensaje);

  const productoAjeno = await pedir(cliente.token, {
    negocio_id: NEGOCIO2, items: [{ producto_id: PROD, cantidad: 8 }],
  });
  check(productoAjeno.status === 400,
    'No se puede pedir el producto de un negocio a nombre de otro', productoAjeno.data?.mensaje);

  console.log('\n── 2. MÉTODOS DE PAGO APAGADOS ──');
  for (const metodo of ['tarjeta', 'mercado_pago']) {
    const r = await pedir(cliente.token, { metodo_pago: metodo });
    check(r.status === 400 && r.data?.codigo === 'METODO_PAGO_DESACTIVADO',
      `metodo_pago="${metodo}" rechazado por el servidor`, r.data?.mensaje);
  }
  const cobro = await api.post('/pagos/tarjeta', { pedido_id: creados[0] || NEGOCIO }, auth(cliente.token));
  check(cobro.status === 503, 'POST /pagos/tarjeta bloqueado (503)', cobro.data?.mensaje);
  const guardar = await api.post('/tarjetas', { token: 'x' }, auth(cliente.token));
  check(guardar.status === 503, 'POST /tarjetas (guardar) bloqueado (503)', guardar.data?.mensaje);
  const listar = await api.get('/tarjetas', auth(cliente.token));
  check(listar.status === 200, 'GET /tarjetas sigue disponible (poder ver/borrar las suyas)');

  console.log('\n── 3. PEDIDO MÍNIMO Y TOPE DE EFECTIVO ──');
  const bajoMinimo = await pedir(cliente.token, { items: [{ producto_id: PROD, cantidad: 2 }] });
  check(bajoMinimo.status === 400 && /mínimo/i.test(bajoMinimo.data?.mensaje || ''),
    'Pedido bajo el mínimo rechazado', bajoMinimo.data?.mensaje);
  const bajoMinimoPickup = await api.post('/pedidos', {
    negocio_id: NEGOCIO, items: [{ producto_id: PROD, cantidad: 2 }],
    metodo_pago: 'efectivo', tipo_envio: 'pickup',
  }, auth(cliente.token));
  check(bajoMinimoPickup.status === 400,
    'Pickup NO sirve para evadir el pedido mínimo', bajoMinimoPickup.data?.mensaje);

  console.log('\n── 4. IDOR: DATOS DE OTROS ──');
  const propio = await pedir(cliente.token);
  const idPropio = propio.data?.data?.pedido?.id;
  if (idPropio) creados.push(idPropio);

  const verOtro = await api.get(`/pedidos/${idPropio}`, auth(repartidor.token));
  const codigoVisible = JSON.stringify(verOtro.data || {}).includes('codigo_entrega');
  check(!codigoVisible || verOtro.status !== 200,
    'El repartidor NO ve el código de entrega de un pedido ajeno',
    `status ${verOtro.status}, código expuesto: ${codigoVisible}`);

  const negocioAjeno = await api.patch(`/pedidos/${idPropio}/estado`, { estado: 'confirmado' }, auth(repartidor.token));
  check(negocioAjeno.status >= 400,
    'Un repartidor no asignado no puede mover el estado del pedido', negocioAjeno.data?.mensaje);

  const clienteEntrega = await api.patch(`/pedidos/${idPropio}/estado`, { estado: 'entregado', codigo_entrega: '1234' }, auth(cliente.token));
  check(clienteEntrega.status >= 400,
    'El cliente no puede marcar su propio pedido como entregado', clienteEntrega.data?.mensaje);

  console.log('\n── 5. TOKENS Y SESIONES ──');
  const tokenFirmadoMal = jwt.sign({ id: cliente.usuario.id, tokenVersion: 0 }, 'secreto-equivocado', { expiresIn: '1h' });
  const conMalo = await api.get('/pedidos', { headers: { Authorization: `Bearer ${tokenFirmadoMal}` } });
  check(conMalo.status === 401, 'Token firmado con otra clave rechazado');

  const [{ token_version: tv }] = await q(`SELECT token_version FROM usuarios WHERE id = :id`, { id: cliente.usuario.id });
  const tokenViejo = jwt.sign({ id: cliente.usuario.id, tokenVersion: (tv || 0) + 5 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const conViejo = await api.get('/pedidos', { headers: { Authorization: `Bearer ${tokenViejo}` } });
  check(conViejo.status === 401, 'Token con versión distinta (sesión revocada) rechazado');

  const sinToken = await api.get('/pedidos/disponibilidad');
  check(sinToken.status === 401, 'El endpoint de disponibilidad exige sesión');

  console.log('\n── 6. FLUJO COMPLETO EN EFECTIVO (a domicilio) ──');
  const flujo = await pedir(cliente.token, { items: [{ producto_id: PROD, cantidad: 8 }] });
  const pf = flujo.data?.data?.pedido;
  if (pf) creados.push(pf.id);
  check(flujo.status === 201, 'Cliente crea el pedido', pf ? `${pf.numero} total $${pf.total}` : flujo.data?.mensaje);
  check(pf && parseFloat(pf.costo_envio) === 40, 'Envío cobrado: $40 flat', pf && `$${pf.costo_envio}`);

  for (const estado of ['confirmado', 'preparando', 'listo']) {
    const r = await api.patch(`/pedidos/${pf.id}/estado`, { estado }, auth(negocio.token));
    check(r.status === 200, `Negocio → ${estado}`, r.data?.mensaje);
  }
  const acepta = await api.post('/repartidores/aceptar-pedido', { pedido_id: pf.id }, auth(repartidor.token));
  check(acepta.status === 200, 'Repartidor acepta', acepta.data?.mensaje);

  const sinCodigo = await api.patch(`/pedidos/${pf.id}/estado`, { estado: 'entregado' }, auth(repartidor.token));
  check(sinCodigo.status === 400, 'No se puede entregar sin el código del cliente', sinCodigo.data?.mensaje);

  const [{ codigo_entrega }] = await q(`SELECT codigo_entrega FROM pedidos WHERE id = :id`, { id: pf.id });
  const malCodigo = await api.patch(`/pedidos/${pf.id}/estado`, { estado: 'entregado', codigo_entrega: '0000' }, auth(repartidor.token));
  check(malCodigo.status === 400, 'Código incorrecto rechazado', malCodigo.data?.mensaje);

  const deudaAntes = (await q(`SELECT deuda_plataforma FROM negocios WHERE id = :id`, { id: NEGOCIO }))[0].deuda_plataforma;
  const entrega = await api.patch(`/pedidos/${pf.id}/estado`, { estado: 'entregado', codigo_entrega }, auth(repartidor.token));
  check(entrega.status === 200, 'Entrega confirmada con el código correcto', entrega.data?.mensaje);

  const ledger = await q(`SELECT * FROM ledger_conciliacion WHERE pedido_id = :id`, { id: pf.id });
  check(ledger.length === 1 && parseFloat(ledger[0].pago_repartidor) === 40 && parseFloat(ledger[0].comision_plataforma) === 35,
    'Ledger correcto: repartidor $40, plataforma $35',
    ledger[0] && `rep $${ledger[0].pago_repartidor} / plat $${ledger[0].comision_plataforma}`);
  const deudaDespues = (await q(`SELECT deuda_plataforma FROM negocios WHERE id = :id`, { id: NEGOCIO }))[0].deuda_plataforma;
  check(Math.round((deudaDespues - deudaAntes) * 100) / 100 === 35,
    'La deuda del restaurante subió exactamente $35', `${deudaAntes} → ${deudaDespues}`);

  console.log('\n── 7. FLUJO COMPLETO PICKUP ──');
  const pk = await api.post('/pedidos', {
    negocio_id: NEGOCIO, items: [{ producto_id: PROD, cantidad: 8 }],
    metodo_pago: 'efectivo', tipo_envio: 'pickup',
  }, auth(cliente.token));
  const pp = pk.data?.data?.pedido;
  if (pp) creados.push(pp.id);
  check(pk.status === 201 && parseFloat(pp.costo_envio) === 0, 'Pickup sin costo de envío', pp && `$${pp.costo_envio}`);

  for (const estado of ['confirmado', 'preparando', 'listo']) {
    await api.patch(`/pedidos/${pp.id}/estado`, { estado }, auth(negocio.token));
  }
  const disponibles = await api.get('/repartidores/pedidos-disponibles', auth(repartidor.token));
  const idsDisp = (disponibles.data?.data?.pedidos || []).map((x) => x.id);
  check(!idsDisp.includes(pp.id), 'Un pickup NO aparece en la lista de pedidos para repartidores');

  const pickupSinCodigo = await api.patch(`/pedidos/${pp.id}/estado`, { estado: 'entregado' }, auth(negocio.token));
  check(pickupSinCodigo.status === 400,
    'El negocio no puede cerrar un pickup sin el código del cliente', pickupSinCodigo.data?.mensaje);

  const [{ codigo_entrega: codPickup }] = await q(`SELECT codigo_entrega FROM pedidos WHERE id = :id`, { id: pp.id });
  const deudaAntesPk = (await q(`SELECT deuda_plataforma FROM negocios WHERE id = :id`, { id: NEGOCIO }))[0].deuda_plataforma;
  const entregaPk = await api.patch(`/pedidos/${pp.id}/estado`, { estado: 'entregado', codigo_entrega: codPickup }, auth(negocio.token));
  check(entregaPk.status === 200, 'Pickup entregado con el código correcto', entregaPk.data?.mensaje);

  const ledgerPk = await q(`SELECT * FROM ledger_conciliacion WHERE pedido_id = :id`, { id: pp.id });
  check(ledgerPk.length === 1 && parseFloat(ledgerPk[0].pago_repartidor) === 0 && parseFloat(ledgerPk[0].comision_plataforma) === 35,
    'Ledger de pickup: repartidor $0, plataforma $35',
    ledgerPk[0] && `rep $${ledgerPk[0].pago_repartidor} / plat $${ledgerPk[0].comision_plataforma}`);
  const deudaDespuesPk = (await q(`SELECT deuda_plataforma FROM negocios WHERE id = :id`, { id: NEGOCIO }))[0].deuda_plataforma;
  check(Math.round((deudaDespuesPk - deudaAntesPk) * 100) / 100 === 35,
    'El restaurante también debe la comisión en pickup', `${deudaAntesPk} → ${deudaDespuesPk}`);

  console.log('\n── 8. SIN REPARTIDORES EN LÍNEA → SOLO PICKUP ──');
  const conectadosAntes = await q(`SELECT id FROM repartidores WHERE conectado = true`);
  await sequelize.query(`UPDATE repartidores SET conectado = false WHERE conectado = true`);
  try {
    const disp = await api.get(`/pedidos/disponibilidad?negocio_id=${NEGOCIO}`, auth(cliente.token));
    const d = disp.data?.data;
    check(d?.envio_disponible === false, 'La app recibe envio_disponible=false');
    check(JSON.stringify(d?.tipos_disponibles) === JSON.stringify(['pickup']),
      'Solo se ofrece PICKUP', JSON.stringify(d?.tipos_disponibles));
    check(!!d?.mensaje && !/repartidor|no hay|sin servicio|no disponible/i.test(d.mensaje),
      'El mensaje es mercadológico, no delata la falta de repartidores', d?.mensaje);

    for (const tipo of ['standard', 'express']) {
      const r = await pedir(cliente.token, { tipo_envio: tipo });
      check(r.status === 409 && r.data?.codigo === 'SOLO_PICKUP',
        `Pedido "${tipo}" rechazado en servidor`, r.data?.mensaje);
    }
    const pkOk = await api.post('/pedidos', {
      negocio_id: NEGOCIO, items: [{ producto_id: PROD, cantidad: 8 }],
      metodo_pago: 'efectivo', tipo_envio: 'pickup',
    }, auth(cliente.token));
    if (pkOk.data?.data?.pedido?.id) creados.push(pkOk.data.data.pedido.id);
    check(pkOk.status === 201, 'Pickup sí se puede pedir sin repartidores en línea');

    // Un repartidor conectado pero con la ruta llena tampoco habilita envío
    await sequelize.query(`UPDATE repartidores SET conectado = true WHERE id = :id`, { replacements: { id: conectadosAntes[0]?.id } });
    const { hayRepartidoresParaEnvio } = require('../services/disponibilidad.service');
    const conUno = await hayRepartidoresParaEnvio('puerto_escondido');
    check(conUno.disponible === true, 'Con un repartidor conectado y con cupo, el envío se reactiva solo',
      `conectados ${conUno.conectados}, con cupo ${conUno.con_cupo}`);
  } finally {
    await sequelize.query(`UPDATE repartidores SET conectado = false`);
    for (const r of conectadosAntes) {
      await sequelize.query(`UPDATE repartidores SET conectado = true WHERE id = :id`, { replacements: { id: r.id } });
    }
  }

  // ── Limpieza de todo lo creado ──
  console.log('\n── LIMPIEZA ──');
  if (creados.length) {
    await sequelize.query(`DELETE FROM ledger_conciliacion WHERE pedido_id IN (:ids)`, { replacements: { ids: creados } });
    await sequelize.query(`DELETE FROM platform_revenue WHERE order_id IN (:ids)`, { replacements: { ids: creados } });
    await sequelize.query(`DELETE FROM pedidos WHERE id IN (:ids)`, { replacements: { ids: creados } });
  }
  // Revierte los $70 de comisión que generaron las dos entregas de prueba
  await sequelize.query(
    `UPDATE negocios SET deuda_plataforma = GREATEST(0, deuda_plataforma - 70),
       pedidos_efectivo_pendientes = GREATEST(0, pedidos_efectivo_pendientes - 2), bloqueado_por_deuda = false
      WHERE id = :id`, { replacements: { id: NEGOCIO } });
  await sequelize.query(
    `UPDATE delivery_batches SET status='completed', completed_at=NOW()
      WHERE status='active' AND NOT EXISTS (
        SELECT 1 FROM pedidos p WHERE p.batch_id = delivery_batches.id
          AND p.estado NOT IN ('entregado','cancelado','rechazado'))`);
  console.log(`${creados.length} pedidos borrados, deuda y rutas revertidas.`);

  console.log(`\n${'═'.repeat(56)}\n${n - malos}/${n} verificaciones OK${malos ? ` — ${malos} PROBLEMA(S)` : ' — sin hallazgos'}`);
  await sequelize.close();
  process.exit(malos ? 1 : 0);
})().catch(async (e) => {
  console.error('\nERROR EN LA AUDITORÍA:', e.message);
  try { await sequelize.close(); } catch (_) {}
  process.exit(1);
});
