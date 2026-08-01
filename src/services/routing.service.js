const { computeRoutes, googleDisponible } = require('./googleMaps.client');

// Ordena destinos: express primero, luego standard.
const priorizarDestinos = (pedidos) => {
  const express  = pedidos.filter(p => p.tipo_envio === 'express');
  const standard = pedidos.filter(p => p.tipo_envio !== 'express');
  return [...express, ...standard];
};

// Ruta optimizada del repartidor: en qué orden conviene entregar sus
// pedidos. Usa Routes API con optimizeWaypointOrder (antes era la
// Directions legacy con `optimize:true`, que Google ya no habilita).
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

  // Google apagado o sin cuota: se devuelven los waypoints en el orden
  // priorizado (express primero) sin salir a la red. El repartidor sigue
  // viendo su ruta, solo que sin optimización ni tiempos de Google.
  if (!(await googleDisponible())) {
    return { waypoints: destinos, route_data: null };
  }

  try {
    const r = await computeRoutes({
      puntos: [origen, ...destinos],
      // Deja que Google reordene las paradas intermedias por el camino más
      // corto. Antes esto era `optimize:true` de la Directions legacy.
      optimizar: intermedios.length > 0,
      // `legs` por tramo para poder mostrar cuánto falta a cada parada.
      camposExtra: 'routes.optimizedIntermediateWaypointIndex,routes.legs.distanceMeters,routes.legs.duration',
      // La cuota ya se reservó en el googleDisponible() de arriba; sin esto
      // cada ruta del repartidor descontaría DOS llamadas del tope diario.
      yaReservada: true,
    });
    if (!r) return { waypoints: destinos, route_data: null };

    // Si Google reordenó las paradas, se respeta su orden. El índice que
    // devuelve se refiere a los INTERMEDIOS (el destino final no se mueve).
    let waypointsOrdenados = destinos;
    const orden = r.crudo?.optimizedIntermediateWaypointIndex;
    if (Array.isArray(orden) && orden.length) {
      waypointsOrdenados = [...orden.map((i) => intermedios[i]).filter(Boolean), ultimo];
    }

    const legs = r.crudo?.legs || [];
    return {
      waypoints: waypointsOrdenados,
      route_data: {
        distancia_total_km: (r.distancia_km).toFixed(2),
        duracion_total_min: r.duracion_min,
        polyline: r.polyline,
        legs: legs.map((l) => ({
          distancia_km: ((l.distanceMeters || 0) / 1000).toFixed(2),
          duracion_min: Math.ceil(parseInt(l.duration, 10) / 60) || 0,
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
 * Sale por googleMaps.client, que es el único punto que habla con Google y
 * el que descuenta la cuota diaria/mensual.
 *
 * Devuelve null si no está disponible (interruptor apagado, cuota agotada,
 * proyecto sin facturación, timeout). El mapa de la app dibuja entonces la
 * línea recta: degradar a una referencia de rumbo es mejor que no tener mapa.
 *
 * @param {Array<{lat:number,lng:number}>} puntos  en orden de recorrido
 * @returns {Promise<{polyline:string, distancia_km:number, duracion_min:number}|null>}
 */
const rutaPorCalles = async (puntos) => {
  const r = await computeRoutes({ puntos });
  if (!r?.polyline) return null;
  return {
    polyline:     r.polyline,
    distancia_km: r.distancia_km,
    duracion_min: r.duracion_min,
  };
};

module.exports = { calcularRuta, rutaPorCalles };
