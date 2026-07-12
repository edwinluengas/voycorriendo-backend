require('dotenv').config();
const { Sequelize } = require('sequelize');
const seq = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, port: process.env.DB_PORT, dialect: 'postgres',
  dialectOptions: { ssl: { rejectUnauthorized: false } }, logging: false
});

seq.authenticate().then(async () => {
  const q = (sql) => seq.query(sql, { type: 'SELECT' });

  const negEstado = await q("SELECT verificacion_estado, COUNT(*) as total FROM negocios GROUP BY verificacion_estado");
  console.log('NEGOCIOS por estado:');
  negEstado.forEach(r => console.log('  ' + (r.verificacion_estado || 'null') + ': ' + r.total));

  const repEstado = await q("SELECT verificacion_estado, COUNT(*) as total FROM repartidores GROUP BY verificacion_estado");
  console.log('REPARTIDORES por estado:');
  repEstado.forEach(r => console.log('  ' + (r.verificacion_estado || 'null') + ': ' + r.total));

  const pedEstado = await q("SELECT estado, COUNT(*) as total FROM pedidos GROUP BY estado ORDER BY total DESC");
  console.log('PEDIDOS por estado:');
  pedEstado.forEach(r => console.log('  ' + r.estado + ': ' + r.total));

  const usuEstado = await q("SELECT estado, COUNT(*) as total FROM usuarios GROUP BY estado");
  console.log('USUARIOS por estado:');
  usuEstado.forEach(r => console.log('  ' + (r.estado || 'null') + ': ' + r.total));

  const recientes = await q("SELECT numero, estado, total, metodo_pago, pago_estado, creado_en FROM pedidos ORDER BY creado_en DESC LIMIT 5");
  console.log('ULTIMOS 5 PEDIDOS:');
  recientes.forEach(r => console.log('  #' + r.numero + ' | ' + r.estado + ' | $' + r.total + ' | ' + r.metodo_pago + ' | pago:' + r.pago_estado + ' | ' + new Date(r.creado_en).toLocaleDateString('es-MX')));

  seq.close();
}).catch(e => { console.error(e.message); process.exit(1); });
