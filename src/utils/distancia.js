/**
 * Cálculo de distancia entre dos coordenadas.
 * 1. Primero revisa caché en route_cache (TTL 24h).
 * 2. Luego intenta Google Maps Distance Matrix (distancia real por carretera).
 * 3. Fallback a haversine (línea recta) si Google falla.
 */
const axios = require('axios');
const crypto = require('crypto');
const { sequelize } = require('../config/database');

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const CACHE_TTL_H = 24;

const hashCoord = (lat, lng) =>
  crypto.createHash('sha256').update(`${lat.toFixed(5)},${lng.toFixed(5)}`).digest('hex').slice(0, 32);

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
    const [rows] = await sequelize.query(
      `SELECT distancia_km, duracion_min FROM route_cache
       WHERE origen_hash = :o AND destino_hash = :d AND expires_at > NOW()
       LIMIT 1`,
      { replacements: { o: origenHash, d: destinoHash }, type: 'SELECT' },
    );
    return rows?.[0] || null;
  } catch (_) { return null; }
};

// ─── Escribir caché ───────────────────────────────────────
const escribirCache = async (origenHash, destinoHash, distancia_km, duracion_min) => {
  try {
    const expires = new Date();
    expires.setHours(expires.getHours() + CACHE_TTL_H);
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
 * Calcula distancia (km) entre origen y destino.
 * @returns {Promise<{ km:number, fuente:'cache'|'google'|'haversine' }>}
 */
const calcularDistanciaKm = async (origen, destino) => {
  const { lat: lat1, lng: lon1 } = origen;
  const { lat: lat2, lng: lon2 } = destino;

  if ([lat1, lon1, lat2, lon2].some((n) => typeof n !== 'number' || Number.isNaN(n))) {
    throw new Error('Coordenadas inválidas para calcular distancia.');
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
      console.warn('Google Maps falló, uso haversine:', e.message);
    }
  }

  // 3. Haversine
  const km = haversineKm(lat1, lon1, lat2, lon2);
  return { km, fuente: 'haversine' };
};

module.exports = { calcularDistanciaKm, haversineKm };
