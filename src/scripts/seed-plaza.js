/**
 * Siembra una plaza con un negocio y un repartidor de demostración.
 *
 *   node src/scripts/seed-plaza.js pinotepa
 *   node src/scripts/seed-plaza.js pinotepa --telefono-base 0000000009
 *
 * Existe porque las plazas de Putla y Zacatepec se poblaron a mano con SQL
 * suelto: al abrir la cuarta (Pinotepa) no había forma de repetir aquello sin
 * volver a escribirlo todo. Es IDEMPOTENTE — correrlo dos veces no duplica
 * nada, actualiza lo que haga falta.
 *
 * Lo que crea, por plaza:
 *   · un usuario "negocio" + su negocio APROBADO y abierto, con las
 *     coordenadas del centro de la plaza (sin coordenadas dentro de la plaza
 *     el negocio no se puede aprobar ni recibir pedidos);
 *   · tres productos con precios que superan el pedido mínimo;
 *   · un usuario "repartidor" + su perfil APROBADO, desconectado (se conecta
 *     él desde la app, y ahí es donde el GPS confirma su plaza).
 *
 * OJO: son cuentas de DEMOSTRACIÓN, no negocios reales — la descripción lo
 * dice para que nadie las confunda en el catálogo.
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const { Usuario, Negocio, Repartidor, Producto } = require('../models');
const { buscar, esValida, SLUGS } = require('../config/ciudades');

const PASSWORD = process.env.SEED_PASSWORD || 'VoyTest2026!';

const PRODUCTOS = [
  { nombre: 'Comida corrida',     precio: 85,  categoria: 'Comida',  descripcion: 'Sopa, guisado del día, arroz y tortillas.' },
  { nombre: 'Pollo asado entero', precio: 180, categoria: 'Comida',  descripcion: 'Con salsas, cebollitas y tortillas.' },
  { nombre: 'Agua fresca 1L',     precio: 35,  categoria: 'Bebidas', descripcion: 'Del sabor del día.' },
];

const HORARIOS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab'].reduce(
  (h, d) => ({ ...h, [d]: { abre: '08:00', cierra: '22:00' } }),
  { dom: { abre: '09:00', cierra: '20:00' } },
);

// Siguiente par de teléfonos libres de la serie 00000000NN que usan las
// cuentas de prueba. Se calcula para no pisar los de otra plaza.
const siguientesTelefonos = async () => {
  const usados = (await Usuario.findAll({
    where: sequelize.literal("telefono ~ '^0{7}[0-9]{3}$'"),
    attributes: ['telefono'],
  })).map((u) => Number(u.telefono));
  let n = 5;
  while (usados.includes(n) || usados.includes(n + 1)) n += 1;
  const f = (x) => String(x).padStart(10, '0');
  return { negocio: f(n), repartidor: f(n + 1) };
};

const sembrar = async (slug) => {
  const plaza = buscar(slug);
  if (!plaza) throw new Error(`"${slug}" no es una plaza. Válidas: ${SLUGS.join(', ')}`);

  // Si ya hay negocio en esa plaza, no se inventa otro.
  const yaHay = await Negocio.findOne({ where: { ciudad: slug } });
  if (yaHay) {
    console.log(`ℹ️  ${plaza.nombre} ya tiene el negocio "${yaHay.nombre}". No se crea otro.`);
  }

  const tel = await siguientesTelefonos();
  console.log(`\n── Sembrando ${plaza.nombre} (${slug}) ──`);

  // ─── Negocio ────────────────────────────────────────────────────
  let uNegocio = await Usuario.findOne({ where: { email: `negocio_${slug}@voycorriendo.com` } });
  if (!uNegocio) {
    uNegocio = await Usuario.create({
      nombre: 'Negocio', apellido: plaza.nombre,
      telefono: tel.negocio, lada: '52', pais: 'MX',
      email: `negocio_${slug}@voycorriendo.com`,
      password: PASSWORD, rol: 'negocio', modo_activo: 'negocio',
    });
    console.log(`   usuario negocio creado — tel ${tel.negocio}`);
  } else {
    console.log(`   usuario negocio ya existía — tel ${uNegocio.telefono}`);
  }

  let negocio = yaHay || await Negocio.findOne({ where: { usuario_id: uNegocio.id } });
  if (!negocio) {
    negocio = await Negocio.create({
      usuario_id: uNegocio.id,
      // Del slug, no del nombre largo: "Santiago Pinotepa Nacional" termina
      // en "Nacional" y el negocio habría quedado como "Cocina Nacional".
      nombre: `Cocina ${slug.charAt(0).toUpperCase()}${slug.slice(1).replace(/_/g, ' ')}`,
      descripcion: 'Cuenta de demostración de la plaza. No es un negocio real.',
      categoria: 'restaurante',
      direccion: `Centro, ${plaza.nombre}`,
      colonia: 'Centro',
      // El centro de la plaza: el negocio DEBE caer dentro de ella o no se
      // puede aprobar (y ningún repartidor de otra plaza lo vería).
      latitud: plaza.latitud, longitud: plaza.longitud,
      telefono: uNegocio.telefono,
      horarios: HORARIOS,
      ciudad: slug,
      activo: true, abierto_ahora: true,
      verificacion_estado: 'aprobado',
      tiempo_entrega_min: 20, tiempo_entrega_max: 40,
    });
    console.log(`   negocio creado — ${negocio.nombre}`);
  } else {
    await negocio.update({ ciudad: slug, activo: true, abierto_ahora: true, verificacion_estado: 'aprobado' });
    console.log(`   negocio ya existía — ${negocio.nombre} (revisado)`);
  }

  for (const p of PRODUCTOS) {
    const [prod, nuevo] = await Producto.findOrCreate({
      where: { negocio_id: negocio.id, nombre: p.nombre },
      defaults: { ...p, negocio_id: negocio.id, disponible: true },
    });
    if (!nuevo) await prod.update({ disponible: true });
  }
  console.log(`   ${PRODUCTOS.length} productos listos`);

  // ─── Repartidor ─────────────────────────────────────────────────
  let uRep = await Usuario.findOne({ where: { email: `repartidor_${slug}@voycorriendo.com` } });
  if (!uRep) {
    uRep = await Usuario.create({
      nombre: 'Repartidor', apellido: plaza.nombre,
      telefono: tel.repartidor, lada: '52', pais: 'MX',
      email: `repartidor_${slug}@voycorriendo.com`,
      password: PASSWORD, rol: 'repartidor', modo_activo: 'repartidor',
    });
    console.log(`   usuario repartidor creado — tel ${tel.repartidor}`);
  } else {
    console.log(`   usuario repartidor ya existía — tel ${uRep.telefono}`);
  }

  const placa = `PL${slug.slice(0, 3).toUpperCase()}01`;
  let rep = await Repartidor.findOne({ where: { usuario_id: uRep.id } });
  if (!rep) {
    rep = await Repartidor.create({
      usuario_id: uRep.id,
      ciudad: slug,
      tipo_vehiculo: 'motocicleta',
      placa_vehiculo: placa,
      marca_vehiculo: 'Italika', modelo_vehiculo: 'FT150', anio_vehiculo: 2023, color_vehiculo: 'Negro',
      verificacion_estado: 'aprobado',
      // Desconectado a propósito: se conecta desde la app y ES AHÍ donde su
      // GPS confirma la plaza. Sembrarlo "en línea" haría creer que hay
      // servicio cuando nadie está trabajando.
      conectado: false, disponible: true,
      latitud: plaza.latitud, longitud: plaza.longitud,
    });
    console.log(`   repartidor creado — placa ${placa}`);
  } else {
    await rep.update({ ciudad: slug, verificacion_estado: 'aprobado' });
    console.log(`   repartidor ya existía — placa ${rep.placa_vehiculo} (revisado)`);
  }

  console.log(`\n✅ ${plaza.nombre} lista.`);
  console.log(`   negocio     → ${uNegocio.telefono} / ${PASSWORD}`);
  console.log(`   repartidor  → ${uRep.telefono} / ${PASSWORD}`);
};

(async () => {
  const slug = process.argv[2];
  if (!slug || !esValida(slug)) {
    console.log(`Uso: node src/scripts/seed-plaza.js <plaza>\nPlazas: ${SLUGS.join(', ')}`);
    process.exit(1);
  }
  try {
    await sembrar(slug);
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
