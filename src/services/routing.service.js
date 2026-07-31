const axios = require('axios');
const { GOOGLE_MAPS_ACTIVO } = require('../config/mapas');

// Ordena destinos: express primero, luego standard.
const priorizarDestinos = (pedidos) => {
  const express  = pedidos.filter(p => p.tipo_envio === 'express');
  const standard = pedidos.filter(p => p.tipo_envio !== 'express');
  return [...express, ...standard];
};

// Llama a Google Maps Directions con optimización de waypoints.
// origen: { lat, lng }
// pedidos: array de Pedido con latitud_entrega / longitud_entrega
// Devuelve { waypoints, route_data } o null si falla.
const calcularRuta = async (origen, pedidos) => {
  if (!pedidos.length) return null;

  const ordenados = priorizarDestinos(pedidos);
  const destinos  = ordenados.map(p => ({
    pedido_id: p.id,
    numero:    p.numero,
    lat:       parseFloat(p.latitud_entrega),
    lng:       parseFloat(p.longitud_entrega),
    direccion: p.direccion_entrega,
    tipo_envio: p.tipo_envio,
  }));

  const ultimo = destinos[destinos.length - 1];
  const intermedios = destinos.slice(0, -1);
  const waypointsStr = intermedios
    .map(d => `${d.lat},${d.lng}`)
    .join('|');

  const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

  // Google apagado (periodo de prueba): se devuelven los waypoints en orden
  // sin salir a la red. Nota: esta funcion usa Directions LEGACY, que Google
  // ya no habilita en proyectos nuevos — si algun dia se enciende Google,
  // migrar esto a Routes API igual que rutaPorCalles.
  if (!GOOGLE_MAPS_ACTIVO || !GOOGLE_MAPS_API_KEY) {
    // Sin API key devolvemos los waypoints ordenados sin datos de Maps
    return { waypoints: destinos, route_data: null };
  }

  try {
    const url = 'https://maps.googleapis.com/maps/api/directions/json';
    const params = {
      origin:      `${origen.lat},${origen.lng}`,
      destination: `${ultimo.lat},${ultimo.lng}`,
      key:         GOOGLE_MAPS_API_KEY,
      mode:        'driving',
      language:    'es',
    };
    if (intermedios.length) {
      params.waypoints = `optimize:true|${waypointsStr}`;
    }

    const { data } = await axios.get(url, { params });

    if (data.status !== 'OK') {
      return { waypoints: destinos, route_data: null };
    }

    // Si Maps reordenó los waypoints, respetamos su orden
    let waypointsOrdenados = destinos;
    if (data.routes?.[0]?.waypoint_order?.length) {
      const orden = data.routes[0].waypoint_order;
      const reordenados = orden.map(i => intermedios[i]);
      waypointsOrdenados = [...reordenados, ultimo];
    }

    return {
      waypoints:  waypointsOrdenados,
      route_data: {
        distancia_total_km: (
          data.routes[0].legs.reduce((s, l) => s + l.distance.value, 0) / 1000
        ).toFixed(2),
        duracion_total_min: Math.ceil(
          data.routes[0].legs.reduce((s, l) => s + l.duration.value, 0) / 60
        ),
        polyline: data.routes[0].overview_polyline?.points,
        legs: data.routes[0].legs.map(l => ({
          distancia_km: (l.distance.value / 1000).toFixed(2),
          duracion_min: Math.ceil(l.duration.value / 60),
        })),
      },
    };
  } catch {
    return { waypoints: destinos, route_data: null };
  }
};

/**
 * Ruta REAL por calles entre 2 o 3 puntos (repartidor → negocio → entrega),
 * para dibujarla en el mapa en vivo de las tres pantallas.
 *
 * Usa la Routes API NUEVA (routes.googleapis.com), no la Directions legacy:
 * Google ya no habilita las legacy en proyectos nuevos — de hecho
 * `calcularRuta` de arriba lleva tiempo devolviendo route_data:null por eso.
 *
 * Devuelve null si la API no está disponible (proyecto sin facturación, API
 * sin habilitar, timeout). El mapa de la app dibuja entonces la línea recta:
 * degradar a una referencia de rumbo es mejor que quedarse sin mapa.
 *
 * @param {Array<{lat:number,lng:number}>} puntos  en orden de recorrido
 * @returns {Promise<{polyline:string, distancia_km:number, duracion_min:number}|null>}
 */
const rutaPorCalles = async (puntos) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const validos = (puntos || []).filter(
    (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)),
  );
  // Sin facturacion activa esta llamada solo genera trafico fallido.
  if (!GOOGLE_MAPS_ACTIVO || !key || validos.length < 2) return null;

  const punto = (p) => ({ location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } } });

  try {
    const { data } = await axios.post(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        origin:        punto(validos[0]),
        destination:   punto(validos[validos.length - 1]),
        intermediates: validos.slice(1, -1).map(punto),
        travelMode:    'DRIVE',
        languageCode:  'es',
        units:         'METRIC',
      },
      {
        timeout: 5000,
        headers: {
          'X-Goog-Api-Key':    key,
          'X-Goog-FieldMask':  'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
        },
      },
    );

    const r = data?.routes?.[0];
    if (!r?.polyline?.encodedPolyline) return null;

    return {
      polyline:     r.polyline.encodedPolyline,
      distancia_km: Number((r.distanceMeters / 1000).toFixed(2)),
      duracion_min: Math.ceil(parseInt(r.duration, 10) / 60) || null,
    };
  } catch (e) {
    // Se avisa una sola vez por arranque para no llenar los logs: si el
    // proyecto no tiene facturación, esto fallaría en CADA pedido.
    if (!rutaPorCalles._avisado) {
      console.warn('[routing] Routes API no disponible, el mapa usará línea recta:',
        e.response?.data?.error?.message || e.message);
      rutaPorCalles._avisado = true;
    }
    return null;
  }
};

module.exports = { calcularRuta, rutaPorCalles };
