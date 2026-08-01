/**
 * Tests de la estimación de distancia — unitarios, sin servidor ni red.
 *
 * Blindan los dos bugs que en julio de 2026 generaron ~608 llamadas
 * fallidas a la Distance Matrix API de Google:
 *   1. `leerCache` destructuraba mal el resultado de Sequelize y devolvía
 *      null SIEMPRE, así que el caché nunca amortiguaba nada.
 *   2. Cuando Google fallaba no se cacheaba el fallback, así que cada
 *      cotización volvía a salir a la red para fallar otra vez.
 */
const axios = require('axios');

describe('Estimación de distancia sin Google', () => {
  let llamadasDeRed;

  beforeAll(() => {
    // Cualquier intento de salir a la red queda registrado aquí.
    llamadasDeRed = [];
    for (const metodo of ['get', 'post']) {
      const original = axios[metodo];
      axios[metodo] = (...args) => {
        llamadasDeRed.push(`${metodo.toUpperCase()} ${args[0]}`);
        return original(...args);
      };
    }
  });

  beforeEach(() => {
    llamadasDeRed.length = 0;
    // Estos tests describen el comportamiento con Google APAGADO, sin
    // importar cómo esté la variable en el entorno donde corran.
    process.env.GOOGLE_MAPS_ACTIVO = 'false';
  });

  afterAll(() => { delete process.env.GOOGLE_MAPS_ACTIVO; });

  test('NO hace ninguna llamada de red con GOOGLE_MAPS_ACTIVO apagado', async () => {
    const { calcularDistanciaKm } = require('../src/utils/distancia');

    await calcularDistanciaKm({ lat: 15.8631, lng: -97.0676 }, { lat: 15.8650, lng: -97.0700 });
    expect(llamadasDeRed).toEqual([]);
  });

  test('la ruta del mapa tampoco sale a la red con Google apagado', async () => {
    const { rutaPorCalles } = require('../src/services/routing.service');

    const ruta = await rutaPorCalles([{ lat: 15.8631, lng: -97.0676 }, { lat: 15.8650, lng: -97.0700 }]);
    expect(ruta).toBeNull();          // la app dibuja la línea recta
    expect(llamadasDeRed).toEqual([]);
  });

  test('aplica el factor de traza urbana sobre la línea recta', async () => {
    const { calcularDistanciaKm, haversineKm } = require('../src/utils/distancia');
    const { FACTOR_RUTA_REAL } = require('../src/config/mapas');

    const a = { lat: 15.8631, lng: -97.0676 };
    const b = { lat: 15.8900, lng: -97.1000 };

    const { km, fuente } = await calcularDistanciaKm(a, b);
    const recta = haversineKm(a.lat, a.lng, b.lat, b.lng);

    expect(fuente).toBe('estimada');
    expect(km).toBeCloseTo(recta * FACTOR_RUTA_REAL, 6);
    // Y nunca puede quedar por DEBAJO de la línea recta: sería imposible.
    expect(km).toBeGreaterThanOrEqual(recta);
  });

  test('el radio de cobertura sigue cubriendo la misma zona que antes', async () => {
    // 5 km en línea recta era el límite viejo; con el factor son 6.5 km
    // estimados, que es el límite nuevo. Un punto que antes entraba, entra.
    const { calcularDistanciaKm } = require('../src/utils/distancia');
    const { MAX_DISTANCE_KM } = require('../src/config/precios');

    expect(MAX_DISTANCE_KM).toBe(6.5);

    // Punto a ~4.9 km en línea recta del origen (entraba con el límite viejo).
    const origen  = { lat: 15.8631, lng: -97.0676 };
    const destino = { lat: 15.8631 + 0.0441, lng: -97.0676 };  // ~4.9 km al norte

    const { km } = await calcularDistanciaKm(origen, destino);
    expect(km).toBeLessThanOrEqual(MAX_DISTANCE_KM);
  });
});

describe('El default del proyecto mantiene Google apagado', () => {
  // Blinda que nadie deje `GOOGLE_MAPS_ACTIVO=true` metido en el código:
  // encenderlo tiene que ser una decisión explícita del entorno (Railway),
  // nunca algo que llegue por accidente en un commit.
  test('sin la variable definida, Google está apagado', () => {
    const previo = process.env.GOOGLE_MAPS_ACTIVO;
    delete process.env.GOOGLE_MAPS_ACTIVO;
    const { googleActivo } = require('../src/config/mapas');
    expect(googleActivo()).toBe(false);
    if (previo !== undefined) process.env.GOOGLE_MAPS_ACTIVO = previo;
  });
});
