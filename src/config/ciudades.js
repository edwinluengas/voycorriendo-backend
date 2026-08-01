/**
 * Ciudades donde opera VoyCorriendo.
 *
 * La ciudad se guarda como slug en `negocios.ciudad` y `repartidores.ciudad`,
 * y el catálogo filtra por ella: un cliente de Putla no ve negocios de
 * Zacatepec. Aunque el filtro fallara, la cobertura de 6.5 km desde cada
 * negocio ya las separa —están a ~25 km— pero no hay que depender de eso:
 * el cliente vería tiendas que nunca podría pedir.
 *
 * Para abrir una plaza nueva basta agregarla aquí y desplegar. NO hace falta
 * tocar lógica: las tarifas, el pedido mínimo y las comisiones son iguales
 * en todas, y la cobertura se mide desde cada negocio, no desde un centro.
 *
 * El slug NUNCA se cambia una vez que hay datos: es lo que quedó escrito en
 * cada negocio y repartidor ya registrado.
 */

const CIUDADES = [
  {
    slug: 'putla',
    nombre: 'Putla Villa de Guerrero',
    estado: 'Oaxaca',
    // Centro aproximado, solo para ordenar y para detectar la ciudad más
    // cercana cuando el cliente comparte su GPS.
    latitud: 17.0247,
    longitud: -97.9281,
  },
  {
    slug: 'zacatepec',
    nombre: 'Santa María Zacatepec',
    estado: 'Oaxaca',
    latitud: 16.7833,
    longitud: -97.9833,
  },
];

// La ciudad con la que se crean las cuentas nuevas si no se dice otra cosa.
// Cambiarla es una variable de entorno, no un despliegue de código.
const CIUDAD_DEFAULT = process.env.CIUDAD_DEFAULT || 'putla';

const SLUGS = CIUDADES.map((c) => c.slug);
const esValida = (slug) => SLUGS.includes(slug);
const buscar = (slug) => CIUDADES.find((c) => c.slug === slug) || null;
const nombreDe = (slug) => buscar(slug)?.nombre || slug;

/**
 * Ciudad más cercana a unas coordenadas. Se usa para asignarle su plaza a
 * quien comparte ubicación, en vez de encajarlo en la de por defecto.
 * Devuelve el default si no hay coordenadas usables.
 */
const masCercana = (lat, lng) => {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return CIUDAD_DEFAULT;
  let mejor = CIUDAD_DEFAULT;
  let menor = Infinity;
  for (const c of CIUDADES) {
    const d = Math.hypot(Number(lat) - c.latitud, Number(lng) - c.longitud);
    if (d < menor) { menor = d; mejor = c.slug; }
  }
  return mejor;
};

module.exports = { CIUDADES, CIUDAD_DEFAULT, SLUGS, esValida, buscar, nombreDe, masCercana };
