/**
 * ÚNICO punto del backend que llama a Google Maps.
 *
 * Todo pasa por aquí a propósito: si las llamadas viven desparramadas, es
 * imposible garantizar qué API se está usando ni contar el gasto. Fue justo
 * lo que pasó — el mapa usaba Routes API pero el cálculo de distancia seguía
 * pegándole a la Distance Matrix legacy sin que nadie lo supiera (608
 * solicitudes registradas contra 0 de Routes).
 *
 * Solo se usa **Routes API** (`computeRoutes`). Las APIs legacy
 * (Distance Matrix, Directions) están eliminadas del proyecto: Google ya no
 * las habilita en proyectos nuevos y facturan aparte.
 *
 * Antes de cada llamada se comprueban dos cosas, en orden:
 *   1. `GOOGLE_MAPS_ACTIVO` — el interruptor general.
 *   2. La cuota propia del día/mes (cuotaGoogle.service).
 * Si cualquiera dice que no, se devuelve null y quien llama usa su cálculo
 * local. Nada revienta: se pierde precisión, no funcionalidad.
 */
const axios = require('axios');
const { googleActivo } = require('../config/mapas');
const { reservarLlamada } = require('./cuotaGoogle.service');

const URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const CAMPOS_BASE = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline';

const coord = (p) => ({
  location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } },
});

const esValido = (p) =>
  p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

/** ¿Se puede gastar una llamada ahora mismo? (interruptor + cuota) */
const googleDisponible = async () => {
  if (!googleActivo() || !process.env.GOOGLE_MAPS_API_KEY) return false;
  return reservarLlamada();
};

/**
 * Ruta por calles entre 2 o más puntos.
 *
 * @param {object}  opts
 * @param {Array}   opts.puntos       [{lat,lng}, ...] en orden de recorrido
 * @param {boolean} opts.optimizar    deja que Google reordene las paradas intermedias
 * @param {string}  opts.camposExtra  FieldMask adicional
 * @param {boolean} opts.yaReservada  true si quien llama ya consumió la cuota
 * @returns {Promise<{polyline, distancia_km, duracion_min, crudo}|null>}
 */
const computeRoutes = async ({ puntos, optimizar = false, camposExtra = '', yaReservada = false }) => {
  const validos = (puntos || []).filter(esValido);
  if (validos.length < 2) return null;
  if (!yaReservada && !(await googleDisponible())) return null;

  try {
    const { data } = await axios.post(
      URL,
      {
        origin:       coord(validos[0]),
        destination:  coord(validos[validos.length - 1]),
        intermediates: validos.slice(1, -1).map(coord),
        travelMode:   'DRIVE',
        languageCode: 'es',
        units:        'METRIC',
        ...(optimizar ? { optimizeWaypointOrder: true } : {}),
      },
      {
        timeout: 5000,
        headers: {
          'X-Goog-Api-Key':   process.env.GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask': camposExtra ? `${CAMPOS_BASE},${camposExtra}` : CAMPOS_BASE,
        },
      },
    );

    const r = data?.routes?.[0];
    if (!r) return null;

    return {
      polyline:     r.polyline?.encodedPolyline || null,
      distancia_km: Number(((r.distanceMeters || 0) / 1000).toFixed(2)),
      duracion_min: Math.ceil(parseInt(r.duration, 10) / 60) || null,
      crudo:        r,
    };
  } catch (e) {
    // Un aviso por arranque: si la cuenta no tiene facturación esto fallaría
    // en cada pedido y llenaría los logs sin aportar nada nuevo.
    if (!computeRoutes._avisado) {
      console.warn('[googleMaps] Routes API no disponible, se usa cálculo local:',
        e.response?.data?.error?.message || e.message);
      computeRoutes._avisado = true;
    }
    return null;
  }
};

module.exports = { computeRoutes, googleDisponible };
