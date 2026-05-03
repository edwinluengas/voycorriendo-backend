/**
 * Patch al seed original — agrega opciones de sabor a aguas frescas
 * y cervezas + cigarros (con requiere_id) a Abarrotes La Esquina.
 *
 * Uso: node src/scripts/seed-patch-opciones-y-restringidos.js
 *
 * Idempotente: se puede correr varias veces sin duplicar productos.
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const { Negocio, Producto } = require('../models');

const OPCIONES_AGUA_DON_CHUY = {
  tipo: 'sabor',
  requerida: true,
  titulo: 'Elige tu sabor',
  valores: ['Jamaica', 'Horchata', 'Tamarindo', 'Limón', 'Piña'],
};

const OPCIONES_AGUA_DONA_LUPE = {
  tipo: 'sabor',
  requerida: true,
  titulo: 'Elige tu sabor',
  valores: ['Jamaica', 'Horchata', 'Tamarindo', 'Limón', 'Chía con limón'],
};

// Productos restringidos que se agregan a Abarrotes La Esquina
const PRODUCTOS_RESTRINGIDOS = [
  { nombre: 'Corona 355ml (6-pack)',          descripcion: 'Cerveza clara, 6 botellas de 355ml',    precio: 115, categoria: 'Cervezas', destacado: true, requiere_id: true },
  { nombre: 'Modelo Especial 355ml (6-pack)', descripcion: 'Cerveza pilsner, 6 botellas de 355ml',  precio: 125, categoria: 'Cervezas', requiere_id: true },
  { nombre: 'Victoria 1.2L (caguama)',        descripcion: 'Cerveza ámbar',                          precio: 45,  categoria: 'Cervezas', requiere_id: true },
  { nombre: 'Tecate Light 473ml',             descripcion: 'Lata individual',                        precio: 25,  categoria: 'Cervezas', requiere_id: true },
  { nombre: 'Cigarros Marlboro Red (cajetilla 20)', descripcion: 'Cajetilla de 20 cigarros',         precio: 85,  categoria: 'Cigarros', requiere_id: true },
  { nombre: 'Cigarros Camel Filters (cajetilla 20)', descripcion: 'Cajetilla de 20 cigarros',        precio: 85,  categoria: 'Cigarros', requiere_id: true },
];

async function agregarOpcionesAAgua(nombreNegocio, opciones, nombreAguaNueva = 'Agua fresca 1L') {
  const negocio = await Negocio.findOne({ where: { nombre: nombreNegocio } });
  if (!negocio) {
    console.log(`⚠️  Negocio "${nombreNegocio}" no encontrado, saltando.`);
    return;
  }
  // Buscar productos con "agua" en el nombre
  const { Op } = require('sequelize');
  const aguas = await Producto.findAll({
    where: { negocio_id: negocio.id, nombre: { [Op.iLike]: '%agua%' } },
  });
  if (aguas.length === 0) {
    // Crear el producto de agua si no existe
    await Producto.create({
      negocio_id: negocio.id,
      nombre: nombreAguaNueva,
      descripcion: 'Recién hecha, elige tu sabor',
      precio: 25,
      categoria: 'Bebidas',
      opciones,
      disponible: true,
    });
    console.log(`✅ [${nombreNegocio}] Creado producto "${nombreAguaNueva}" con opciones de sabor.`);
    return;
  }
  for (const agua of aguas) {
    agua.opciones = opciones;
    // Actualizar nombre/descripción para reflejar que ahora tiene sabores
    if (!agua.nombre.toLowerCase().includes('fresca') && !agua.nombre.toLowerCase().includes('sabores')) {
      agua.nombre = nombreAguaNueva;
      agua.descripcion = 'Recién hecha, elige tu sabor';
    }
    await agua.save();
    console.log(`✅ [${nombreNegocio}] Opciones agregadas a "${agua.nombre}".`);
  }
}

async function agregarProductosRestringidos() {
  const negocio = await Negocio.findOne({ where: { nombre: 'Abarrotes La Esquina' } });
  if (!negocio) {
    console.log(`⚠️  "Abarrotes La Esquina" no encontrado, saltando.`);
    return;
  }
  let agregados = 0;
  let saltados = 0;
  for (const prod of PRODUCTOS_RESTRINGIDOS) {
    const existe = await Producto.findOne({
      where: { negocio_id: negocio.id, nombre: prod.nombre },
    });
    if (existe) {
      // Actualizar requiere_id por si quedó false antes de la migración
      if (!existe.requiere_id) {
        existe.requiere_id = true;
        await existe.save();
        console.log(`🔄 [${negocio.nombre}] Marcado "${prod.nombre}" como requiere_id=true.`);
      } else {
        saltados++;
      }
      continue;
    }
    await Producto.create({ ...prod, negocio_id: negocio.id, disponible: true });
    agregados++;
    console.log(`✅ [${negocio.nombre}] Agregado "${prod.nombre}" (${prod.categoria}).`);
  }
  console.log(`\n📊 Abarrotes La Esquina: ${agregados} nuevos, ${saltados} ya existían.`);
}

async function main() {
  try {
    console.log('🌱 Patch de opciones y productos restringidos...\n');
    await sequelize.authenticate();
    console.log('✅ Conectado a la base de datos\n');

    await agregarOpcionesAAgua('Taquería Don Chuy', OPCIONES_AGUA_DON_CHUY, 'Agua fresca 1L');
    await agregarOpcionesAAgua('Comida Casera Doña Lupe', OPCIONES_AGUA_DONA_LUPE, 'Agua fresca 1L');
    console.log('');
    await agregarProductosRestringidos();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 Patch completo.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error en patch:', error);
    process.exit(1);
  }
}

main();
