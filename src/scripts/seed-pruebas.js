/**
 * Deja la cuenta del dueño (5545074460) lista para probar la app COMPLETA
 * desde los tres lados, sin tener que pasar por los tres onboardings a mano.
 *
 * Los tres escenarios que la app permite a una misma cuenta:
 *   1. CLIENTE     — pide comida (es el rol base, siempre disponible).
 *   2. REPARTIDOR  — perfil aprobado, conectado y con fondo listo para cobrar.
 *   3. NEGOCIO     — restaurante aprobado, abierto, con productos y GPS.
 *
 * Nota: una cuenta solo puede tener UN negocio (`activarModoNegocio` rechaza
 * el segundo), así que "restaurante" y "negocio" son el mismo perfil — lo que
 * cambia es la `categoria`. Con `--tienda` se siembra como tienda de
 * conveniencia en vez de restaurante.
 *
 * Es idempotente: si los perfiles ya existen los actualiza en vez de
 * duplicar, así que se puede correr las veces que haga falta.
 *
 *   node src/scripts/seed-pruebas.js             (simulacro)
 *   node src/scripts/seed-pruebas.js --aplicar
 *   node src/scripts/seed-pruebas.js --aplicar --tienda
 */
require('dotenv').config();
const { Sequelize } = require('sequelize');
const { sequelize } = require('../config/database');
const { Usuario, Repartidor, Negocio, Producto, FondoRepartidor } = require('../models');
const { encrypt } = require('../utils/crypto');

const TELEFONO = process.env.SEED_TELEFONO || '5545074460';
const APLICAR  = process.argv.includes('--aplicar');
const TIENDA   = process.argv.includes('--tienda');
// --tests siembra ADEMÁS el escenario con IDs fijos que espera la suite.
const TESTS    = process.argv.includes('--tests');

// IDs FIJOS: los tests los tienen escritos a mano (NEGOCIO_DON_BETO,
// PRODUCTO_PASTOR, PRODUCTO_QUESADILLA). Si cambian aquí, la suite se rompe.
const DON_BETO = {
  id: '33333333-0000-0000-0000-000000000001',
  nombre: 'Tacos Don Beto',
  descripcion: 'Cuenta de pruebas de la suite automática. No es un negocio real.',
  categoria: 'restaurante',
  direccion: 'Calle de pruebas 1', colonia: 'Centro', ciudad: 'puerto_escondido',
  latitud: 15.8631, longitud: -97.0676,
  tiempo_entrega_min: 15, tiempo_entrega_max: 30,
};
// Segundo negocio con ID fijo (SEGUNDO_NEGOCIO en la suite): tiene que
// quedar a MÁS de 1.5 km de Don Beto — es el caso de "recoger en un negocio
// lejano" que debe rechazarse. 0.017° de latitud ≈ 1.9 km.
const LA_LUPITA = {
  id: '33333333-0000-0000-0000-000000000002',
  nombre: 'Mariscos La Lupita',
  descripcion: 'Cuenta de pruebas de la suite automática. No es un negocio real.',
  categoria: 'restaurante',
  direccion: 'Calle de pruebas 2', colonia: 'Centro', ciudad: 'puerto_escondido',
  latitud: 15.8801, longitud: -97.0676,
  tiempo_entrega_min: 15, tiempo_entrega_max: 30,
};

// Los precios importan: 5 pastor + 1 quesadilla = $155, justo por encima
// del pedido mínimo de $150 que usan los tests.
const PRODUCTOS_TEST = [
  { id: '36f7d479-f8c6-484e-9999-7e5561fc78fe', nombre: 'Taco de pastor', precio: 22, categoria: 'Tacos' },
  { id: '32d21de7-d001-42b1-b614-128327e2f96e', nombre: 'Quesadilla',     precio: 45, categoria: 'Antojitos' },
];

// Coordenadas reales de Puerto Escondido — el negocio NO puede quedar sin
// GPS: sin coordenadas no se puede calcular cobertura y no recibe pedidos.
const NEGOCIO = {
  nombre: 'Yard House',
  descripcion: 'Cocina mexicana y mariscos frescos. Cuenta de pruebas del dueño.',
  categoria: TIENDA ? 'tienda_conveniencia' : 'restaurante',
  direccion: 'Av. Benito Juárez 97, Bacocho',
  colonia: 'Bacocho',
  ciudad: 'puerto_escondido',
  latitud: 15.86407636,
  longitud: -97.07730897,
  tiempo_entrega_min: 20,
  tiempo_entrega_max: 40,
  horarios: {
    lun: { abre: '09:00', cierra: '22:00' }, mar: { abre: '09:00', cierra: '22:00' },
    mie: { abre: '09:00', cierra: '22:00' }, jue: { abre: '09:00', cierra: '22:00' },
    vie: { abre: '09:00', cierra: '23:00' }, sab: { abre: '09:00', cierra: '23:00' },
    dom: { abre: '10:00', cierra: '21:00' },
  },
};

// Precios pensados para probar de verdad el flujo: con el pedido mínimo en
// $150, dos productos de estos ya lo superan sin tener que pedir 8 tacos.
const PRODUCTOS = [
  { nombre: 'Tacos de pastor (orden)', descripcion: '5 tacos con piña, cebolla y cilantro', precio: 95,  categoria: 'Tacos' },
  { nombre: 'Aguachile de camarón',    descripcion: 'Camarón fresco, limón y chile serrano', precio: 185, categoria: 'Mariscos' },
  { nombre: 'Hamburguesa de la casa',  descripcion: 'Carne de res, tocino y papas',          precio: 145, categoria: 'Hamburguesas' },
  { nombre: 'Agua de horchata 1L',     descripcion: 'Hecha en casa',                          precio: 45,  categoria: 'Bebidas' },
  { nombre: 'Cerveza artesanal',       descripcion: 'Producto con restricción de edad',       precio: 75,  categoria: 'Bebidas', requiere_id: true },
];

const REPARTIDOR = {
  tipo_vehiculo: 'motocicleta',
  marca_vehiculo: 'Italika',
  modelo_vehiculo: 'FT150',
  anio_vehiculo: 2023,
  placa_vehiculo: 'PRUEBA01',
  color_vehiculo: 'Rojo',
  banco: 'BBVA',
  ciudad: 'puerto_escondido',
  latitud: 15.8640,
  longitud: -97.0773,
};

(async () => {
  console.log(APLICAR ? '=== SEED REAL ===\n' : '=== SIMULACRO (usa --aplicar) ===\n');

  const usuario = await Usuario.findOne({ where: { telefono: TELEFONO } });
  if (!usuario) {
    console.error(`No existe la cuenta ${TELEFONO}. Regístrala primero desde la app.`);
    process.exit(1);
  }
  console.log(`Cuenta: ${usuario.nombre} ${usuario.apellido || ''} (${TELEFONO})`);
  console.log(`  1. CLIENTE     — rol base, ya disponible`);
  console.log(`  2. REPARTIDOR  — ${REPARTIDOR.marca_vehiculo} ${REPARTIDOR.modelo_vehiculo}, placa ${REPARTIDOR.placa_vehiculo}`);
  console.log(`  3. NEGOCIO     — ${NEGOCIO.nombre} (${NEGOCIO.categoria}), ${PRODUCTOS.length} productos`);
  if (TESTS) console.log(`  + escenario de la suite: ${DON_BETO.nombre} y el repartidor de prueba`);

  if (!APLICAR) { console.log('\n[simulacro] no se escribió nada.'); await sequelize.close(); return; }

  // ── 2. REPARTIDOR ────────────────────────────────────────
  // Aprobado y conectado: `disponibilidad.service` solo cuenta repartidores
  // con latido reciente, y sin eso la app solo ofrece pickup.
  const [rep] = await Repartidor.findOrCreate({
    where: { usuario_id: usuario.id },
    defaults: { usuario_id: usuario.id, ...REPARTIDOR },
  });
  await rep.update({
    ...REPARTIDOR,
    verificacion_estado: 'aprobado',
    antecedentes_ok: true,
    estado_cuenta: 'normal',
    baja_permanente: false,
    conectado: true,
    disponible: true,
    ultimo_latido: new Date(),
    resolucion_en: new Date(),
    clabe_bancaria: encrypt('012180012345678901'),
  });
  await FondoRepartidor.findOrCreate({
    where: { repartidor_id: rep.id },
    defaults: { repartidor_id: rep.id, monto_disponible: 0, monto_reservado: 0 },
  });
  console.log('\n  ✓ perfil de REPARTIDOR aprobado y conectado');

  // ── 3. NEGOCIO ───────────────────────────────────────────
  const [neg] = await Negocio.findOrCreate({
    where: { usuario_id: usuario.id },
    defaults: { usuario_id: usuario.id, ...NEGOCIO },
  });
  await neg.update({
    ...NEGOCIO,
    telefono: TELEFONO,
    verificacion_estado: 'aprobado',
    estado_cuenta: 'normal',
    activo: true,
    abierto_ahora: true,
    bloqueado_por_deuda: false,
    deuda_plataforma: 0,
    pedidos_efectivo_pendientes: 0,
    resolucion_en: new Date(),
    clabe_bancaria: encrypt('012180012345678901'),
    banco: 'BBVA',
  });
  console.log('  ✓ perfil de NEGOCIO aprobado, abierto y con GPS');

  // Productos: se reemplazan para que correr el seed dos veces no los duplique.
  await Producto.destroy({ where: { negocio_id: neg.id } });
  for (const p of PRODUCTOS) {
    await Producto.create({ ...p, negocio_id: neg.id, disponible: true });
  }
  console.log(`  ✓ ${PRODUCTOS.length} productos (uno con restricción de edad, para probar el INE)`);

  // La cuenta arranca en modo cliente; desde Perfil se cambia a repartidor o
  // negocio sin cerrar sesión (RootNavigator re-renderiza solo).
  await usuario.update({ modo_activo: 'cliente' });

  // ── Escenario de la SUITE (--tests) ──────────────────────
  // Los 43 tests apuntan a IDs fijos: "Tacos Don Beto" y dos productos con
  // precios exactos ($22 y $45, que suman el pedido mínimo). Sin esto la
  // suite no puede correr, que es como quedarse sin red de seguridad.
  if (TESTS) {
    const dueno = await Usuario.findOne({ where: { telefono: '0000000003' } });
    const driver = await Usuario.findOne({ where: { telefono: '0000000004' } });
    if (!dueno || !driver) {
      console.log('\n  · faltan las cuentas 0000000003/0000000004: no se sembró el escenario de tests');
    } else {
      const [negT] = await Negocio.findOrCreate({
        where: { id: DON_BETO.id },
        defaults: { ...DON_BETO, usuario_id: dueno.id },
      });
      await negT.update({
        ...DON_BETO, usuario_id: dueno.id,
        verificacion_estado: 'aprobado', estado_cuenta: 'normal',
        activo: true, abierto_ahora: true, bloqueado_por_deuda: false,
        deuda_plataforma: 0, pedidos_efectivo_pendientes: 0,
      });
      await Producto.destroy({ where: { negocio_id: negT.id } });
      for (const p of PRODUCTOS_TEST) {
        await Producto.create({ ...p, negocio_id: negT.id, disponible: true });
      }

      // Segundo negocio, solo para el caso de "recogida fuera de ruta".
      // OJO: tiene que ser de OTRO dueño. `pedidosDelNegocio` resuelve el
      // negocio con findOne({usuario_id}), así que si los dos colgaran de
      // 0000000003 el backend podría devolver el equivocado y la lista de
      // pedidos del negocio saldría vacía sin razón aparente.
      const duenoAlterno = await Usuario.findOne({ where: { telefono: '0000000001' } }) || dueno;
      const [negL] = await Negocio.findOrCreate({
        where: { id: LA_LUPITA.id },
        defaults: { ...LA_LUPITA, usuario_id: duenoAlterno.id },
      });
      await negL.update({
        ...LA_LUPITA, usuario_id: duenoAlterno.id,
        verificacion_estado: 'aprobado', estado_cuenta: 'normal',
        activo: true, abierto_ahora: true,
      });

      const [repT] = await Repartidor.findOrCreate({
        where: { usuario_id: driver.id },
        defaults: { usuario_id: driver.id, ...REPARTIDOR, placa_vehiculo: 'TEST0001' },
      });
      await repT.update({
        ...REPARTIDOR, placa_vehiculo: 'TEST0001',
        verificacion_estado: 'aprobado', antecedentes_ok: true,
        estado_cuenta: 'normal', baja_permanente: false,
        conectado: true, disponible: true, ultimo_latido: new Date(),
      });
      await FondoRepartidor.findOrCreate({
        where: { repartidor_id: repT.id },
        defaults: { repartidor_id: repT.id, monto_disponible: 0, monto_reservado: 0 },
      });
      console.log('  ✓ escenario de la suite: Don Beto + La Lupita + productos + repartidor');
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('Listo. Entra con ' + TELEFONO + ' y cambia de modo desde Perfil.');
  console.log('  · Como CLIENTE puedes pedirle a tu propio negocio.');
  console.log('  · Como NEGOCIO confirmas y preparas ese pedido.');
  console.log('  · Como REPARTIDOR lo aceptas y lo entregas con el código.');
  console.log('─────────────────────────────────────────────');

  await sequelize.close();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
