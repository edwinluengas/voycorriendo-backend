/**
 * Timeout "listo sin repartidor" — cuenta desde que quedó LISTO.
 *
 * Bug real (auditoría 2026-10-16): el job medía desde `creado_en`, así que un
 * pedido que tardaba más de 15 min en cocinarse se cancelaba apenas quedaba
 * listo, como pérdida cargada al restaurante. Y también cancelaba pickups,
 * que nunca llevan repartidor.
 *
 * Usa las cuentas de prueba (0000000001-4) contra el backend de TEST_BASE_URL
 * y llama al job directamente contra la misma base.
 */
const { cliente, login, conAuth } = require('./helpers/api');
const { conectar } = require('./helpers/db');
const { cancelarPedidosExpirados } = require('../src/jobs/pedidoTimeout.job');
const { sequelize } = require('../src/config/database');

jest.setTimeout(30000);

const NEGOCIO = '33333333-0000-0000-0000-000000000001';
const PASTOR = '36f7d479-f8c6-484e-9999-7e5561fc78fe';
const QUESADILLA = '32d21de7-d001-42b1-b614-128327e2f96e';
const CERCA = { lat: 15.8650, lng: -97.0700 };

let db;
const creados = [];

const estado = async (id) => (await db.query('SELECT estado FROM pedidos WHERE id = $1', [id])).rows[0].estado;

const pedidoListo = async (tipo_envio) => {
  const { token } = await login('cliente');
  // "Un pedido a la vez": que no estorbe uno pendiente de otra corrida.
  await db.query(`UPDATE pedidos SET estado = 'cancelado' WHERE estado = 'pendiente'
                    AND cliente_id = (SELECT id FROM usuarios WHERE telefono = '0000000002')`);
  const r = await cliente.post('/pedidos', {
    negocio_id: NEGOCIO,
    items: [{ producto_id: PASTOR, cantidad: 5 }, { producto_id: QUESADILLA, cantidad: 1 }],
    direccion_entrega: 'Test automatizado — ignorar',
    latitud_entrega: CERCA.lat, longitud_entrega: CERCA.lng,
    metodo_pago: 'efectivo', tipo_envio,
  }, conAuth(token));
  expect(r.status).toBe(201);
  const id = r.data.data.pedido.id;
  creados.push(id);
  const { token: tn } = await login('negocio');
  for (const e of ['confirmado', 'preparando', 'listo']) {
    const x = await cliente.patch(`/pedidos/${id}/estado`, { estado: e }, conAuth(tn));
    expect(x.status).toBe(200);
  }
  return id;
};

beforeAll(async () => {
  db = await conectar();
  await db.query(`UPDATE repartidores SET conectado = true, ultimo_latido = NOW()
                   WHERE usuario_id = (SELECT id FROM usuarios WHERE telefono = '0000000004')`);
  await db.query(`UPDATE negocios SET abierto_ahora = true, ultimo_latido = NOW(), deuda_plataforma = 0,
                    pedidos_efectivo_pendientes = 0, bloqueado_por_deuda = false, estado_cuenta = 'normal'
                   WHERE id = $1`, [NEGOCIO]);
});

afterAll(async () => {
  try {
    if (creados.length) {
      await db.query(`DELETE FROM perdidas_pedido WHERE pedido_id = ANY($1)`, [creados]);
      await db.query(`DELETE FROM pedidos WHERE id = ANY($1)`, [creados]);
    }
    // La pérdida cargó deuda al negocio de PRUEBA: se deja en cero.
    await db.query(`UPDATE negocios SET deuda_plataforma = 0, pedidos_efectivo_pendientes = 0, bloqueado_por_deuda = false
                     WHERE id = $1`, [NEGOCIO]);
    await db.query(`UPDATE repartidores SET conectado = false, ultimo_latido = NULL
                     WHERE usuario_id = (SELECT id FROM usuarios WHERE telefono = '0000000004')`);
  } finally {
    await db.end();
    await sequelize.close();
  }
});

test('marcar "listo" guarda listo_en', async () => {
  const id = await pedidoListo('standard');
  const r = await db.query('SELECT listo_en FROM pedidos WHERE id = $1', [id]);
  expect(r.rows[0].listo_en).not.toBeNull();
});

test('un pedido creado hace 40 min pero recién listo NO se cancela', async () => {
  const id = creados[0];
  await db.query(`UPDATE pedidos SET creado_en = NOW() - INTERVAL '40 minutes', listo_en = NOW() WHERE id = $1`, [id]);
  await cancelarPedidosExpirados();
  expect(await estado(id)).toBe('listo');
});

test('un pedido listo hace 20 min sin repartidor SÍ se cancela', async () => {
  const id = creados[0];
  await db.query(`UPDATE pedidos SET listo_en = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [id]);
  await cancelarPedidosExpirados();
  expect(await estado(id)).toBe('cancelado');
});

test('un pickup listo nunca se cancela por "sin repartidor"', async () => {
  const id = await pedidoListo('pickup');
  await db.query(`UPDATE pedidos SET creado_en = NOW() - INTERVAL '60 minutes', listo_en = NOW() - INTERVAL '60 minutes' WHERE id = $1`, [id]);
  await cancelarPedidosExpirados();
  expect(await estado(id)).toBe('listo');
});

test('un repartidor no puede aceptar un pickup aunque tenga el id', async () => {
  const id = creados[1];
  const { token } = await login('repartidor');
  const r = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: id }, conAuth(token));
  expect(r.status).toBe(409);
  expect(await estado(id)).toBe('listo');
});
