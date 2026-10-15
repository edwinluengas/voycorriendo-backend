/**
 * Un negocio "abierto" sin nadie atendiendo se cierra solo.
 *
 * Bug real (Sabor a Mi, Putla, octubre 2026): `abierto_ahora` se quedaba
 * prendido para siempre aunque la dueña llevaba días sin abrir la app; los
 * clientes le pedían y cada pedido se cancelaba solo a los 20 minutos.
 *
 * Usa el negocio de prueba (0000000003). Las cuentas de prueba están exentas
 * del cierre en producción, así que aquí se llama al servicio pidiendo
 * explícitamente incluirla y limitado a ese único negocio.
 */
const { cliente, login, conAuth } = require('./helpers/api');
const { conectar } = require('./helpers/db');
const { cerrarNegociosInactivos } = require('../src/services/disponibilidad.service');

let token, negocioId, estadoOriginal, db;

const fijar = (abierto, latidoSql) => db.query(
  `UPDATE negocios SET abierto_ahora = $1, ultimo_latido = ${latidoSql} WHERE id = $2`,
  [abierto, negocioId],
);
const abierto = async () => (await db.query('SELECT abierto_ahora FROM negocios WHERE id = $1', [negocioId])).rows[0].abierto_ahora;

beforeAll(async () => {
  ({ token } = await login('negocio'));
  const r = await cliente.get('/negocios/mi-negocio', conAuth(token));
  negocioId = r.data.data.negocio.id;
  db = await conectar();
  estadoOriginal = (await db.query('SELECT abierto_ahora, ultimo_latido FROM negocios WHERE id = $1', [negocioId])).rows[0];
});

afterAll(async () => {
  await db.query('UPDATE negocios SET abierto_ahora = $1, ultimo_latido = $2 WHERE id = $3',
    [estadoOriginal.abierto_ahora, estadoOriginal.ultimo_latido, negocioId]);
  await db.end().catch(() => {});
  // El servicio usa el pool de Sequelize: cerrarlo para que Jest termine.
  await require('../src/config/database').sequelize.close().catch(() => {});
});

describe('Cierre de negocios inactivos', () => {
  test('abierto y sin ninguna señal de vida → se cierra', async () => {
    await fijar(true, 'NULL');
    const n = await cerrarNegociosInactivos({ soloIds: [negocioId], incluirCuentasPrueba: true });
    expect(n).toBe(1);
    expect(await abierto()).toBe(false);
  });

  test('abierto con señal reciente → sigue abierto', async () => {
    await fijar(true, 'NOW()');
    const n = await cerrarNegociosInactivos({ soloIds: [negocioId], incluirCuentasPrueba: true });
    expect(n).toBe(0);
    expect(await abierto()).toBe(true);
  });

  test('las cuentas de prueba están exentas en la corrida normal', async () => {
    await fijar(true, "NOW() - INTERVAL '3 days'");
    const n = await cerrarNegociosInactivos({ soloIds: [negocioId] });
    expect(n).toBe(0);
    expect(await abierto()).toBe(true);
  });

  test('abrir el negocio desde la app renueva su latido', async () => {
    await fijar(false, "NOW() - INTERVAL '3 days'");
    const r = await cliente.patch('/negocios/apertura', { abierto: true }, conAuth(token));
    expect(r.status).toBe(200);
    const fila = (await db.query('SELECT ultimo_latido FROM negocios WHERE id = $1', [negocioId])).rows[0];
    expect(Date.now() - new Date(fila.ultimo_latido).getTime()).toBeLessThan(5 * 60 * 1000);
  });
});
