const axios = require('axios');

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

  if (!GOOGLE_MAPS_API_KEY) {
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

module.exports = { calcularRuta };
