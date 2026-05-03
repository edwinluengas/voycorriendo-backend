/**
 * Cálculo de distancia entre dos coordenadas.
 *
 * Preferimos Google Maps Distance Matrix (distancia real por carretera).
 * Si no hay API key o la llamada falla, caemos a haversine (línea recta).
 * Así el backend nunca se queda sin un número.
 */
const axios = require('axios');

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ─── Haversine (línea recta, gratis) ──────────────────────
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // Radio de la Tierra en km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// ─── Google Maps Distance Matrix ──────────────────────────
// Docs: https://developers.google.com/maps/documentation/distance-matrix
const googleDistanciaKm = async (lat1, lon1, lat2, lon2) => {
  if (!GOOGLE_API_KEY) throw new Error('Sin GOOGLE_MAPS_API_KEY');
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json';
  const { data } = await axios.get(url, {
    timeout: 5000,
    params: {
      origins: `${lat1},${lon1}`,
      destinations: `${lat2},${lon2}`,
      units: 'metric',
      mode: 'driving',
      key: GOOGLE_API_KEY,
    },
  });
  const elem = data?.rows?.[0]?.elements?.[0];
  if (!elem || elem.status !== 'OK') {
    throw new Error(`Google Maps respondió: ${elem?.status || 'sin datos'}`);
  }
  // distance.value viene en metros
  return elem.distance.value / 1000;
};

/**
 * Calcula distancia (km) entre origen y destino.
 * @param {{lat:number, lng:number}} origen
 * @param {{lat:number, lng:number}} destino
 * @returns {Promise<{ km:number, fuente:'google'|'haversine' }>}
 */
const calcularDistanciaKm = async (origen, destino) => {
  const { lat: lat1, lng: lon1 } = origen;
  const { lat: lat2, lng: lon2 } = destino;

  // Validar coordenadas
  if ([lat1, lon1, lat2, lon2].some((n) => typeof n !== 'number' || Number.isNaN(n))) {
    throw new Error('Coordenadas inválidas para calcular distancia.');
  }

  // 1. Intentar Google Maps
  if (GOOGLE_API_KEY) {
    try {
      const km = await googleDistanciaKm(lat1, lon1, lat2, lon2);
      return { km, fuente: 'google' };
    } catch (e) {
      console.warn('Google Maps falló, uso haversine:', e.message);
    }
  }

  // 2. Fallback haversine
  const km = haversineKm(lat1, lon1, lat2, lon2);
  return { km, fuente: 'haversine' };
};

module.exports = { calcularDistanciaKm, haversineKm };
