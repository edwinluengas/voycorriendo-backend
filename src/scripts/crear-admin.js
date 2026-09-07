'use strict';

require('dotenv').config();
const { sequelize, conectarDB } = require('../config/database');
const Usuario = require('../models/Usuario');

// La password NO se hardcodea: este script crea/actualiza una cuenta con rol
// admin contra la base que apunte .env — incluida producción. Tenerla en el
// repo significaba que cualquiera con acceso al código (o al historial de git)
// tenía la llave del panel de administración.
//
// Uso:
//   ADMIN_SEED_PASSWORD='...' node src/scripts/crear-admin.js
//
// Sin default a propósito: un valor por defecto es exactamente el agujero que
// esto viene a cerrar, porque termina siendo el que queda en producción.
const PASSWORD_ADMIN = process.env.ADMIN_SEED_PASSWORD;
const LARGO_MINIMO = 12;

if (!PASSWORD_ADMIN) {
  console.error([
    'ERROR: falta la variable de entorno ADMIN_SEED_PASSWORD.',
    '',
    'Este script no tiene contraseña por defecto. Defínela antes de correrlo:',
    '',
    "  PowerShell:  $env:ADMIN_SEED_PASSWORD='...'; node src/scripts/crear-admin.js",
    "  bash:        ADMIN_SEED_PASSWORD='...' node src/scripts/crear-admin.js",
    '',
    'O agrégala a tu archivo .env (que no se sube a git).',
  ].join('\n'));
  process.exit(1);
}

if (PASSWORD_ADMIN.length < LARGO_MINIMO) {
  console.error([
    `ERROR: ADMIN_SEED_PASSWORD debe tener al menos ${LARGO_MINIMO} caracteres `
      + `(recibí ${PASSWORD_ADMIN.length}).`,
    'Es la cuenta con rol admin: no la dejes débil.',
  ].join('\n'));
  process.exit(1);
}

const DATOS_ADMIN = {
  nombre: 'Edwin',
  apellido: 'Luengas',
  telefono: '7712345678',
  email: 'admin@voycorriendo.app',
  password: PASSWORD_ADMIN,
  rol: 'admin',
  modo_activo: 'admin',
  estado: 'activo',
  telefono_verificado: true,
};

async function crearOActualizarAdmin() {
  await conectarDB();

  const [usuario, creado] = await Usuario.findOrCreate({
    where: { telefono: DATOS_ADMIN.telefono },
    defaults: DATOS_ADMIN,
  });

  if (creado) {
    console.log('✓ Usuario admin creado exitosamente.');
    console.log(`  ID: ${usuario.id}`);
    console.log(`  Teléfono: ${usuario.telefono}`);
    console.log(`  Email: ${usuario.email}`);
    console.log(`  Rol: ${usuario.rol}`);
    console.log(`  Estado: ${usuario.estado}`);
  } else {
    // Actualiza todos los campos relevantes; el hook beforeUpdate hashea
    // el password sólo si realmente cambió.
    await usuario.update({
      nombre: DATOS_ADMIN.nombre,
      apellido: DATOS_ADMIN.apellido,
      email: DATOS_ADMIN.email,
      password: DATOS_ADMIN.password,
      rol: DATOS_ADMIN.rol,
      modo_activo: DATOS_ADMIN.modo_activo,
      estado: DATOS_ADMIN.estado,
      telefono_verificado: DATOS_ADMIN.telefono_verificado,
    });
    console.log('✓ Usuario admin actualizado exitosamente.');
    console.log(`  ID: ${usuario.id}`);
    console.log(`  Teléfono: ${usuario.telefono}`);
    console.log(`  Email: ${usuario.email}`);
    console.log(`  Rol: ${usuario.rol}`);
    console.log(`  Estado: ${usuario.estado}`);
  }

  await sequelize.close();
}

crearOActualizarAdmin().catch((err) => {
  console.error('Error al crear/actualizar admin:', err.message);
  process.exit(1);
});
