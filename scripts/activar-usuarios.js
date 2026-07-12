/**
 * Activa manualmente usuarios en estado 'pendiente'.
 * Útil cuando Twilio trial no puede enviar SMS a números no verificados.
 *
 * Uso:
 *   node scripts/activar-usuarios.js              → activa TODOS los pendientes
 *   node scripts/activar-usuarios.js 5512345678   → activa solo ese número
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const Usuario = require('../src/models/Usuario');
const { Op } = require('sequelize');

const telefono = process.argv[2];

sequelize.authenticate().then(async () => {
  const where = telefono
    ? { telefono }
    : { estado: { [Op.in]: ['pendiente', 'inactivo'] } };

  const usuarios = await Usuario.findAll({ where });

  if (usuarios.length === 0) {
    console.log('No se encontraron usuarios con ese criterio.');
    await sequelize.close();
    return;
  }

  for (const u of usuarios) {
    await u.update({ estado: 'activo', telefono_verificado: true });
    console.log(`✅ ACTIVADO: ${u.nombre} ${u.apellido} | ${u.telefono} | rol: ${u.rol}`);
  }

  console.log(`\nTotal activados: ${usuarios.length}`);
  await sequelize.close();
}).catch(e => { console.error(e.message); process.exit(1); });
