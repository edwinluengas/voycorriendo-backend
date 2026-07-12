require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { Usuario, Repartidor } = require('../src/models');

sequelize.authenticate().then(async () => {
  // Check repartidor test account ciudad
  const u = await Usuario.findOne({ where: { telefono: '0000000004' } });
  if (u) {
    const rep = await Repartidor.findOne({ where: { usuario_id: u.id } });
    console.log('REPARTIDOR TEST:');
    console.log('  usuario_id:', u.id);
    console.log('  ciudad del repartidor:', rep ? rep.ciudad : 'SIN REPARTIDOR VINCULADO');
    console.log('  verificacion_estado:', rep ? rep.verificacion_estado : 'N/A');
    console.log('  tipo_vehiculo:', rep ? rep.tipo_vehiculo : 'N/A');
    if (rep && !rep.ciudad) {
      await rep.update({ ciudad: 'puerto_escondido' });
      console.log('  ✅ ciudad actualizada a puerto_escondido');
    } else if (rep) {
      console.log('  ciudad OK:', rep.ciudad);
    }
  } else {
    console.log('❌ No se encontró usuario 0000000004');
  }

  // Check PlatformRevenue table
  const [rows] = await sequelize.query('SELECT COUNT(*) as total FROM "PlatformRevenues"');
  console.log('\nPlatformRevenues rows:', rows[0].total);

  // Check table exists
  const [tables] = await sequelize.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%revenue%'`
  );
  console.log('Revenue tables found:', tables.map(t => t.table_name));

  await sequelize.close();
}).catch(e => { console.error(e.message); process.exit(1); });
