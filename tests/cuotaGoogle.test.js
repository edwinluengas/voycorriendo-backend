/**
 * Freno de gasto propio de Google Maps.
 *
 * Las cuotas de la consola de Google topan CANTIDAD de solicitudes, no
 * dinero — no existe un "cap" en dólares que apague solo. Esta suite
 * comprueba la capa que sí controlamos: la del código.
 *
 * Toca la tabla real `google_api_uso` y limpia lo suyo al terminar.
 */
require('dotenv').config();
const { Sequelize } = require('sequelize');
const { sequelize } = require('../src/config/database');

// La DB es remota (Supabase): 5s por defecto no alcanzan.
jest.setTimeout(30000);

const q = (sql, replacements) =>
  sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT, replacements });

// Deja el contador de HOY como estaba, para no ensuciar métricas reales.
let respaldo = null;

beforeAll(async () => {
  const filas = await q(`SELECT * FROM google_api_uso WHERE dia = CURRENT_DATE`);
  respaldo = filas[0] || null;
  await q(`DELETE FROM google_api_uso WHERE dia = CURRENT_DATE`);
});

afterAll(async () => {
  await q(`DELETE FROM google_api_uso WHERE dia = CURRENT_DATE`);
  if (respaldo) {
    await q(
      `INSERT INTO google_api_uso (dia, llamadas, alertado_diario, alertado_mensual)
       VALUES (CURRENT_DATE, :n, :ad, :am)`,
      { n: respaldo.llamadas, ad: respaldo.alertado_diario, am: respaldo.alertado_mensual },
    );
  }
  await sequelize.close();
});

describe('Freno de gasto de Google Maps', () => {
  test('cada reserva incrementa el contador del día', async () => {
    const { reservarLlamada, consumo } = require('../src/services/cuotaGoogle.service');

    await reservarLlamada();
    await reservarLlamada();
    await reservarLlamada();

    const c = await consumo();
    expect(c.hoy).toBe(3);
  });

  test('al pasar el límite diario deja de autorizar llamadas', async () => {
    process.env.GOOGLE_MAPS_LIMITE_DIARIO = '5';
    const { reservarLlamada, _resetCache } = require('../src/services/cuotaGoogle.service');
    _resetCache();

    await q(`UPDATE google_api_uso SET llamadas = 0, alertado_diario = false WHERE dia = CURRENT_DATE`);

    const resultados = [];
    for (let i = 0; i < 8; i++) resultados.push(await reservarLlamada());

    // Las primeras 5 pasan; de ahí en adelante, ninguna.
    expect(resultados.slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(resultados.slice(5)).toEqual([false, false, false]);
  });

  test('una vez topado, el bloqueo se mantiene sin volver a consultar', async () => {
    process.env.GOOGLE_MAPS_LIMITE_DIARIO = '2';
    const { reservarLlamada, _resetCache } = require('../src/services/cuotaGoogle.service');
    _resetCache();
    await q(`UPDATE google_api_uso SET llamadas = 0, alertado_diario = false WHERE dia = CURRENT_DATE`);

    await reservarLlamada();
    await reservarLlamada();
    expect(await reservarLlamada()).toBe(false);

    // El contador ya no debe seguir creciendo: si el freno ya cerró, ni
    // siquiera se toca la base por cada request que llega después.
    const antes = (await q(`SELECT llamadas FROM google_api_uso WHERE dia = CURRENT_DATE`))[0].llamadas;
    await reservarLlamada();
    await reservarLlamada();
    const despues = (await q(`SELECT llamadas FROM google_api_uso WHERE dia = CURRENT_DATE`))[0].llamadas;
    expect(despues).toBe(antes);
  });

  test('con la cuota agotada, la ruta cae al cálculo local sin tronar', async () => {
    process.env.GOOGLE_MAPS_ACTIVO = 'true';    // Google encendido...
    process.env.GOOGLE_MAPS_LIMITE_DIARIO = '0'; // ...pero sin cuota
    const { _resetCache } = require('../src/services/cuotaGoogle.service');
    _resetCache();
    const { rutaPorCalles } = require('../src/services/routing.service');
    const { calcularDistanciaKm } = require('../src/utils/distancia');

    // No revienta: devuelve null y el mapa dibuja la línea recta.
    const ruta = await rutaPorCalles([{ lat: 15.8631, lng: -97.0676 }, { lat: 15.8650, lng: -97.0700 }]);
    expect(ruta).toBeNull();

    // Y la distancia sigue saliendo sin haber ido a Google. Se acepta
    // 'estimada' o 'cache' (una corrida anterior pudo dejar el fallback
    // cacheado); lo que NUNCA puede pasar es que diga 'google', porque eso
    // significaría que se gastó una llamada teniendo la cuota cerrada.
    const d = await calcularDistanciaKm({ lat: 15.8631, lng: -97.0676 }, { lat: 15.8650, lng: -97.0700 });
    expect(d.km).toBeGreaterThan(0);
    expect(d.fuente).not.toBe('google');

    delete process.env.GOOGLE_MAPS_ACTIVO;
    delete process.env.GOOGLE_MAPS_LIMITE_DIARIO;
  });
});
