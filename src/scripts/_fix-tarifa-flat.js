/**
 * Aplica la tarifa plana en producción: limpia el recargo por km de
 * config_zonas (causa real de que el envío cambiara de precio entre pedidos).
 */
require('dotenv').config();
const { sequelize } = require('../config/database');

(async () => {
  const q = (s) => sequelize.query(s, { type: sequelize.QueryTypes.SELECT });
  console.log('ANTES:', await q('SELECT tipo_envio, max_km, fee_base, surcharge_inicio_km, surcharge_por_km FROM config_zonas ORDER BY tipo_envio'));
  await sequelize.query(`UPDATE config_zonas SET surcharge_inicio_km = NULL, surcharge_por_km = NULL`);
  await sequelize.query(`UPDATE config_zonas SET fee_base = 35, max_km = 5 WHERE tipo_envio = 'standard'`);
  await sequelize.query(`UPDATE config_zonas SET fee_base = 60, max_km = 5 WHERE tipo_envio = 'express'`);
  console.log('DESPUÉS:', await q('SELECT tipo_envio, max_km, fee_base, surcharge_inicio_km, surcharge_por_km FROM config_zonas ORDER BY tipo_envio'));
  await sequelize.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
