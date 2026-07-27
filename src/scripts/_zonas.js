require('dotenv').config();
const { sequelize } = require('../config/database');
(async () => {
  const q = (s) => sequelize.query(s, { type: sequelize.QueryTypes.SELECT });
  console.log('config_zonas:', await q('SELECT * FROM config_zonas'));
  console.log('config_comisiones:', await q('SELECT metodo_pago,tipo_envio,comision_plataforma,pago_repartidor FROM config_comisiones'));
  console.log('promo_config:', await q('SELECT clave,activo FROM promo_config'));
  await sequelize.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
