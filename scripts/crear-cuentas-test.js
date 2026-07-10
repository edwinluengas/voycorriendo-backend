/**
 * Crea 4 cuentas de testing con credenciales conocidas.
 * Si ya existen por teléfono, actualiza el password.
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { Usuario, Negocio, Repartidor } = require('../src/models');

const PASS = 'VoyTest2026!';

const cuentas = [
  {
    telefono: '0000000001',
    nombre: 'Admin', apellido: 'VoyCorriendo',
    rol: 'admin', modo_activo: 'admin',
    email: 'admin_test@voycorriendo.mx',
  },
  {
    telefono: '0000000002',
    nombre: 'Cliente', apellido: 'Test',
    rol: 'cliente', modo_activo: 'cliente',
    email: 'cliente_test@voycorriendo.mx',
  },
  {
    telefono: '0000000003',
    nombre: 'Negocio', apellido: 'Test',
    rol: 'negocio', modo_activo: 'negocio',
    email: 'negocio_test@voycorriendo.mx',
  },
  {
    telefono: '0000000004',
    nombre: 'Repartidor', apellido: 'Test',
    rol: 'repartidor', modo_activo: 'repartidor',
    email: 'repartidor_test@voycorriendo.mx',
  },
];

sequelize.authenticate().then(async () => {
  const ids = {};

  for (const c of cuentas) {
    let u = await Usuario.findOne({ where: { telefono: c.telefono } });
    if (u) {
      // Asignar password como texto plano para que beforeUpdate lo hashee UNA sola vez
      u.password = PASS;
      u.rol = c.rol;
      u.modo_activo = c.modo_activo;
      u.estado = 'activo';
      u.telefono_verificado = true;
      await u.save();
      console.log(`ACTUALIZADO: ${c.nombre} ${c.apellido} (${c.telefono})`);
    } else {
      u = await Usuario.create({
        ...c,
        password: PASS, // hook beforeCreate hashea automáticamente
        estado: 'activo',
        telefono_verificado: true,
      });
      console.log(`CREADO: ${c.nombre} ${c.apellido} (${c.telefono})`);
    }
    ids[c.rol] = u.id;
  }

  // Vincular cuenta negocio a un negocio aprobado real
  const negocioExistente = await Negocio.findOne({
    where: { verificacion_estado: 'aprobado' },
    order: [['creado_en', 'ASC']],
  });
  if (negocioExistente && ids.negocio) {
    await negocioExistente.update({ usuario_id: ids.negocio });
    console.log(`\nNEGOCIO VINCULADO: "${negocioExistente.nombre}" → cuenta 0000000003`);
  }

  // Vincular cuenta repartidor a un repartidor aprobado real
  const repExistente = await Repartidor.findOne({
    where: { verificacion_estado: 'aprobado' },
    order: [['creado_en', 'ASC']],
  });
  if (repExistente && ids.repartidor) {
    await repExistente.update({ usuario_id: ids.repartidor });
    console.log(`REPARTIDOR VINCULADO: (${repExistente.tipo_vehiculo || 'moto'}) → cuenta 0000000004`);
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║         CUENTAS DE TESTING LISTAS           ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║ 🔑 PASSWORD TODOS: ${PASS.padEnd(25)}║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║ ROL          TELÉFONO       LOGIN           ║');
  console.log('║ Admin        0000000001                     ║');
  console.log('║ Cliente      0000000002                     ║');
  console.log('║ Negocio      0000000003                     ║');
  console.log('║ Repartidor   0000000004                     ║');
  console.log('╚══════════════════════════════════════════════╝');

  await sequelize.close();
}).catch(e => { console.error(e.message); process.exit(1); });
