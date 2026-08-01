/**
 * Cálculo de distancia entre dos coordenadas.
 *
 * Con Google APAGADO (el default hoy — ver config/mapas.js): se estima en
 * local con haversine × FACTOR_RUTA_REAL. Cero llamadas de red, cero costo,
 * respuesta instantánea.
 *
 * Con Google ENCENDIDO: 1) caché en route_cache, 2) Routes API (distancia
 * real por carretera, sujeta a la cuota propia), 3) estimación local.
 */
const crypto = require('crypto');
const { sequelize } = require('../config/database');
const { googleActivo, FACTOR_RUTA_REAL } = require('../config/mapas');
const { computeRoutes } = require('../services/googleMaps.client');

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const CACHE_TTL_H = 24;
// TTL corto para lo que se resolvió sin Google: si mañana se enciende, la
// estimación local no se queda pegada un día entero tapando el dato bueno.
const CACHE_TTL_FALLBACK_H = 1;

// 4 decimales ≈ 11 m. Antes eran 5 (≈ 1 m), y con esa precisión dos lecturas
// de GPS del mismo portal nunca caían en la misma clave: el caché no acertaba
// jamás aunque estuviera bien escrito.
const hashCoord = (lat, lng) =>
  crypto.createHash('sha256').update(`${lat.toFixed(4)},${lng.toFixed(4)}`).digest('hex').slice(0, 32);

// ─── Haversine (línea recta, fallback) ───────────────────
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ─── Leer caché ───────────────────────────────────────────
const leerCache = async (origenHash, destinoHash) => {
  try {
    // OJO con el destructuring: con `type: 'SELECT'` Sequelize YA devuelve el
    // array de filas, no la tupla [filas, metadata]. El código anterior hacía
    // `const [rows] = await ...`, con lo que `rows` quedaba siendo la PRIMERA
    // FILA (un objeto) y `rows?.[0]` era siempre undefined → el caché nunca
    // acertaba, ni con filas válidas en la tabla. Ese bug es el que dejaba
    // salir a Google en cada cotización.
    const filas = await sequelize.query(
      `SELECT distancia_km, duracion_min FROM route_cache
       WHERE origen_hash = :o AND destino_hash = :d AND expires_at > NOW()
       LIMIT 1`,
      { replacements: { o: origenHash, d: destinoHash }, type: 'SELECT' },
    );
    return filas?.[0] || null;
  } catch (_) { return null; }
};

// ─── Escribir caché ───────────────────────────────────────
const escribirCache = async (origenHash, destinoHash, distancia_km, duracion_min, horas = CACHE_TTL_H) => {
  try {
    const expires = new Date();
    expires.setHours(expires.getHours() + horas);
    await sequelize.query(
      `INSERT INTO route_cache (origen_hash, destino_hash, distancia_km, duracion_min, expires_at)
       VALUES (:o, :d, :km, :dur, :exp)
       ON CONFLICT (origen_hash, destino_hash)
       DO UPDATE SET distancia_km = EXCLUDED.distancia_km, duracion_min = EXCLUDED.duracion_min, expires_at = EXCLUDED.expires_at`,
      { replacements: { o: origenHash, d: destinoHash, km: distancia_km, dur: duracion_min, exp: expires } },
    );
  } catch (_) { /* cache write failure is non-fatal */ }
};

// ─── Distancia real por Routes API ────────────────────────
// Antes esto pegaba a la Distance Matrix API (legacy). Se eliminó: Google
// ya no la habilita en proyectos nuevos y factura como SKU aparte — era la
// que acumulaba las 608 solicitudes fallidas. Ahora sale por el cliente
// único, que además descuenta la cuota diaria/mensual.
const googleDistanciaKm = async (lat1, lon1, lat2, lon2) => {
  const r = await computeRoutes({
    puntos: [{ lat: lat1, lng: lon1 }, { lat: lat2, lng: lon2 }],
  });
  if (!r) throw new Error('Routes API no disponible');
  return { km: r.distancia_km, min: r.duracion_min };
};

/**
 * Estimación local del recorrido real: línea recta corregida por el factor
 * de traza urbana. Es lo que se usa mientras no se pague Google.
 */
const estimacionLocalKm = (lat1, lon1, lat2, lon2) =>
  haversineKm(lat1, lon1, lat2, lon2) * FACTOR_RUTA_REAL;

/**
 * Calcula distancia (km) entre origen y destino.
 * @returns {Promise<{ km:number, fuente:'cache'|'google'|'estimada' }>}
 */
const calcularDistanciaKm = async (origen, destino) => {
  const { lat: lat1, lng: lon1 } = origen;
  const { lat: lat2, lng: lon2 } = destino;

  if ([lat1, lon1, lat2, lon2].some((n) => typeof n !== 'number' || Number.isNaN(n))) {
    throw new Error('Coordenadas inválidas para calcular distancia.');
  }

  // Google apagado: se resuelve en local y NO se toca la red ni la base.
  // Calcular haversine cuesta microsegundos — cachearlo en Postgres sería
  // más lento que recalcularlo.
  if (!googleActivo()) {
    return { km: estimacionLocalKm(lat1, lon1, lat2, lon2), fuente: 'estimada' };
  }

  const origenHash  = hashCoord(lat1, lon1);
  const destinoHash = hashCoord(lat2, lon2);

  // 1. Caché
  const cached = await leerCache(origenHash, destinoHash);
  if (cached) return { km: Number(cached.distancia_km), fuente: 'cache' };

  // 2. Google Maps
  if (GOOGLE_API_KEY) {
    try {
      const { km, min } = await googleDistanciaKm(lat1, lon1, lat2, lon2);
      await escribirCache(origenHash, destinoHash, km, min);
      return { km, fuente: 'google' };
    } catch (e) {
      console.warn('Google Maps falló, uso estimación local:', e.message);
      // Se cachea también el fallo (TTL corto): si Google está caído o la
      // cuenta sin facturación, sin esto CADA cotización vuelve a salir a
      // la red para fallar otra vez — exactamente lo que pasó estas semanas.
      const km = estimacionLocalKm(lat1, lon1, lat2, lon2);
      await escribirCache(origenHash, destinoHash, km, null, CACHE_TTL_FALLBACK_H);
      return { km, fuente: 'estimada' };
    }
  }

  // 3. Estimación local
  return { km: estimacionLocalKm(lat1, lon1, lat2, lon2), fuente: 'estimada' };
};

module.exports = { calcularDistanciaKm, haversineKm };
