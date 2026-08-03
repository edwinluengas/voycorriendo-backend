/**
 * Plazas (localidades) donde opera VoyCorriendo.
 *
 * La plaza se guarda como slug en `negocios.ciudad`, `repartidores.ciudad` y
 * `pedidos.ciudad`, y TODO se filtra por ella: un cliente de Zacatepec no ve
 * negocios de Puerto Escondido, y un repartidor de Putla no ve —ni puede
 * aceptar— pedidos de otra plaza.
 *
 * La plaza NO se teclea: se deduce de las coordenadas reales (`plazaDe`).
 * Un dueño de negocio confirma su GPS y el sistema decide en qué plaza queda;
 * un repartidor la hereda de dónde se conecta. Así nadie puede colocarse en
 * una plaza que no le toca escribiendo un slug en el body.
 *
 * Para abrir una plaza nueva basta agregarla aquí y desplegar. NO hace falta
 * tocar lógica ni sacar APK nuevo: la app lee la lista de /api/config-publica.
 * Las tarifas, el pedido mínimo y las comisiones son iguales en todas, y la
 * cobertura de reparto se mide desde cada negocio, no desde un centro.
 *
 * El slug NUNCA se cambia una vez que hay datos: es lo que quedó escrito en
 * cada negocio, repartidor y pedido ya registrado.
 */

// `marca` es como se llama el servicio EN esa plaza. La app lo muestra en la
// bienvenida y el encabezado: quien vive en Putla no quiere pedirle a una app
// "de Puerto Escondido", quiere la suya. Es el mismo servicio, pero el nombre
// local es lo que lo hace propio.
//
// Puerto Escondido va SIN apellido —"VoyCorriendo" a secas— por decisión del
// dueño: es la casa matriz y la marca ahí es la marca general.
const CIUDADES = [
  {
    slug: 'puerto_escondido',
    nombre: 'Puerto Escondido',
    marca: 'VoyCorriendo',
    estado: 'Oaxaca',
    latitud: 15.8631,
    longitud: -97.0676,
  },
  {
    slug: 'putla',
    nombre: 'Putla Villa de Guerrero',
    marca: 'VoyCorriendo Putla',
    estado: 'Oaxaca',
    latitud: 17.0247,
    longitud: -97.9281,
  },
  {
    slug: 'zacatepec',
    nombre: 'Santa María Zacatepec',
    marca: 'VoyCorriendo Zacatepec',
    estado: 'Oaxaca',
    latitud: 16.7833,
    longitud: -97.9833,
  },
  {
    slug: 'pinotepa',
    nombre: 'Santiago Pinotepa Nacional',
    marca: 'VoyCorriendo Pinotepa',
    estado: 'Oaxaca',
    latitud: 16.3417,
    longitud: -98.0533,
  },
];

// La ciudad con la que se crean las cuentas nuevas si no se dice otra cosa.
// Cambiarla es una variable de entorno, no un despliegue de código.
const CIUDAD_DEFAULT = process.env.CIUDAD_DEFAULT || 'puerto_escondido';

// Hasta dónde llega una plaza. No es la cobertura de reparto (6.5 km desde
// cada negocio, en config/precios) sino el área que razonablemente pertenece
// al pueblo y sus alrededores. Más allá de esto NO hay servicio, y hay que
// decirlo en vez de encajar a la persona en la plaza más cercana.
const RADIO_PLAZA_KM = Number(process.env.RADIO_PLAZA_KM) || 25;

const SLUGS = CIUDADES.map((c) => c.slug);
const esValida = (slug) => SLUGS.includes(slug);
const buscar = (slug) => CIUDADES.find((c) => c.slug === slug) || null;
const nombreDe = (slug) => buscar(slug)?.nombre || slug;
const marcaDe  = (slug) => buscar(slug)?.marca || 'VoyCorriendo';

/**
 * Distancia real en km (haversine).
 *
 * NO se puede comparar en grados: medio grado son ~55 km de latitud pero
 * bastante menos de longitud, así que un umbral en grados daría un área
 * distinta según dónde estés — y a 16° de latitud el error es del 4%.
 */
const distanciaKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

/**
 * La plaza a la que pertenecen unas coordenadas.
 *
 * Devuelve `{ slug, km, dentro }`. `dentro=false` significa que el punto cae
 * fuera de TODAS las plazas: ahí no hay servicio y hay que decirlo, no
 * asignarle la más cercana. Sin coordenadas usables devuelve `slug: null` —
 * quien llame decide qué hacer, pero nunca se inventa una plaza.
 */
const plazaDe = (lat, lng) => {
  // OJO: `Number(null)` es 0 y `Number('')` también, así que un chequeo solo
  // con isFinite daba por buenas unas coordenadas ausentes y las situaba en
  // el Golfo de Guinea —de ahí salía una plaza "más cercana" a 10 000 km.
  if (lat === null || lat === undefined || lat === ''
   || lng === null || lng === undefined || lng === '') {
    return { slug: null, km: null, dentro: false };
  }
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) {
    return { slug: null, km: null, dentro: false };
  }
  let mejor = null, menor = Infinity;
  for (const c of CIUDADES) {
    const d = distanciaKm(la, ln, c.latitud, c.longitud);
    if (d < menor) { menor = d; mejor = c.slug; }
  }
  return { slug: mejor, km: menor, dentro: menor <= RADIO_PLAZA_KM };
};

/**
 * Compatibilidad: la plaza más cercana, sin importar la distancia.
 * Preferir `plazaDe` — ésta encaja a cualquiera en una plaza aunque esté a
 * 500 km, que es justo lo que causaba que alguien de fuera viera el catálogo
 * de Putla y pudiera intentar pedir.
 */
const masCercana = (lat, lng) => plazaDe(lat, lng).slug || CIUDAD_DEFAULT;

module.exports = {
  CIUDADES, CIUDAD_DEFAULT, SLUGS, RADIO_PLAZA_KM,
  esValida, buscar, nombreDe, marcaDe, distanciaKm, plazaDe, masCercana,
};
