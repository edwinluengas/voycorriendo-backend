'use strict';

require('dotenv').config();
const { sequelize, conectarDB } = require('../config/database');
const Usuario = require('../models/Usuario');

const DATOS_ADMIN = {
  nombre: 'Edwin',
  apellido: 'Luengas',
  telefono: '7712345678',
  email: 'admin@voycorriendo.app',
  password: 'VoyAdmin2026!',
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
