/**
 * Compatibilidad de ruta para agrupar pedidos (batch) — VoyCorriendo
 * ------------------------------------------------------------------
 * Regla del dueño (2026-07-26): el repartidor puede llevar hasta 3 pedidos a
 * la vez para maximizar su utilidad, PERO solo si van de verdad en la misma
 * ruta. Antes la única condición era "mismo negocio", lo cual dejaba fuera
 * combinaciones buenas (dos taquerías a media cuadra, mismo rumbo de
 * entrega) y a la vez permitía combinaciones malas (mismo restaurante pero
 * entregas en extremos opuestos de la ciudad).
 *
 * Criterio, con distancias en línea recta (Haversine — basta para decidir
 * compatibilidad, no hace falta gastar llamadas a Google Maps):
 *   1. La RECOGIDA nueva debe estar cerca de alguna recogida ya en la ruta
 *      (mismo negocio = 0 km, siempre pasa).
 *   2. La ENTREGA nueva debe estar cerca de alguna entrega ya en la ruta.
 *   3. Si falta cualquier coordenada, se RECHAZA. Fail-closed: dejar pasar lo
 *      que no se puede verificar fue exactamente el bug del pedido a 3,744 km
 *      (MND-280836).
 */
const num = (clave, def) => {
  const raw = process.env[clave];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

// Puerto Escondido es chico: 1.5 km entre recogidas y 2 km entre entregas
// mantiene el desvío por debajo de ~5 min. Ajustables por env var.
const MAX_KM_ENTRE_RECOGIDAS = num('BATCH_MAX_KM_RECOGIDA', 1.5);
const MAX_KM_ENTRE_ENTREGAS  = num('BATCH_MAX_KM_ENTREGA', 2.0);

const RADIO_TIERRA_KM = 6371;
const rad = (g) => (g * Math.PI) / 180;

const distanciaKm = (a, b) => {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.sqrt(h));
};

const coord = (lat, lng) => {
  const la = parseFloat(lat), ln = parseFloat(lng);
  return Number.isFinite(la) && Number.isFinite(ln) ? { lat: la, lng: ln } : null;
};

/**
 * ¿El pedido nuevo cabe en la ruta que el repartidor ya trae?
 *
 * @param {Object}   candidato        { pedido, negocio }
 * @param {Array}    enRuta           [{ pedido, negocio }] — pedidos NO terminales del batch
 * @returns {{ compatible: boolean, motivo: string, kmRecogida?: number, kmEntrega?: number }}
 */
const evaluarCompatibilidad = ({ candidato, enRuta }) => {
  if (!enRuta || enRuta.length === 0) {
    return { compatible: true, motivo: 'Primer pedido de la ruta.' };
  }

  // Express viaja solo — regla de negocio anterior, se respeta aquí también.
  if (candidato.pedido.tipo_envio === 'express' || enRuta.some((e) => e.pedido.tipo_envio === 'express')) {
    return { compatible: false, motivo: 'Los pedidos Express viajan solos, sin combinarse con otros.' };
  }

  const recogidaNueva = coord(candidato.negocio?.latitud, candidato.negocio?.longitud);
  const entregaNueva  = coord(candidato.pedido.latitud_entrega, candidato.pedido.longitud_entrega);
  if (!recogidaNueva || !entregaNueva) {
    return { compatible: false, motivo: 'No podemos verificar que vaya en tu misma ruta (le faltan coordenadas).' };
  }

  let mejorRecogida = Infinity;
  let mejorEntrega  = Infinity;
  for (const item of enRuta) {
    const r = coord(item.negocio?.latitud, item.negocio?.longitud);
    const e = coord(item.pedido.latitud_entrega, item.pedido.longitud_entrega);
    if (!r || !e) {
      return { compatible: false, motivo: 'No podemos verificar tu ruta actual (a un pedido le faltan coordenadas).' };
    }
    mejorRecogida = Math.min(mejorRecogida, distanciaKm(recogidaNueva, r));
    mejorEntrega  = Math.min(mejorEntrega,  distanciaKm(entregaNueva,  e));
  }

  const kmRecogida = +mejorRecogida.toFixed(2);
  const kmEntrega  = +mejorEntrega.toFixed(2);

  if (mejorRecogida > MAX_KM_ENTRE_RECOGIDAS) {
    return {
      compatible: false, kmRecogida, kmEntrega,
      motivo: `La tienda está a ${kmRecogida} km de tu recogida actual (máximo ${MAX_KM_ENTRE_RECOGIDAS} km para ir en la misma ruta).`,
    };
  }
  if (mejorEntrega > MAX_KM_ENTRE_ENTREGAS) {
    return {
      compatible: false, kmRecogida, kmEntrega,
      motivo: `La entrega queda a ${kmEntrega} km de las tuyas (máximo ${MAX_KM_ENTRE_ENTREGAS} km para ir en la misma ruta).`,
    };
  }

  return {
    compatible: true, kmRecogida, kmEntrega,
    motivo: `Va en tu misma ruta: recogida a ${kmRecogida} km, entrega a ${kmEntrega} km.`,
  };
};

module.exports = {
  evaluarCompatibilidad,
  distanciaKm,
  MAX_KM_ENTRE_RECOGIDAS,
  MAX_KM_ENTRE_ENTREGAS,
};
