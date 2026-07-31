/**
 * Cálculo de distancia entre dos coordenadas.
 *
 * Con Google APAGADO (el default hoy — ver config/mapas.js): se estima en
 * local con haversine × FACTOR_RUTA_REAL. Cero llamadas de red, cero costo,
 * respuesta instantánea.
 *
 * Con Google ENCENDIDO: 1) caché en route_cache, 2) Distance Matrix
 * (distancia real por carretera), 3) fallback a la estimación local.
 */
const axios = require('axios');
const crypto = require('crypto');
const { sequelize } = require('../config/database');
const { GOOGLE_MAPS_ACTIVO, FACTOR_RUTA_REAL } = require('../config/mapas');

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

// ─── Google Maps Distance Matrix ──────────────────────────
const googleDistanciaKm = async (lat1, lon1, lat2, lon2) => {
  if (!GOOGLE_API_KEY) throw new Error('Sin GOOGLE_MAPS_API_KEY');
  const { data } = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
    timeout: 5000,
    params: {
      origins:      `${lat1},${lon1}`,
      destinations: `${lat2},${lon2}`,
      units:        'metric',
      mode:         'driving',
      key:          GOOGLE_API_KEY,
    },
  });
  const elem = data?.rows?.[0]?.elements?.[0];
  if (!elem || elem.status !== 'OK') {
    throw new Error(`Google Maps respondió: ${elem?.status || 'sin datos'}`);
  }
  return {
    km:  elem.distance.value / 1000,
    min: Math.ceil((elem.duration?.value || 0) / 60),
  };
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
  if (!GOOGLE_MAPS_ACTIVO) {
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
