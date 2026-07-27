/**
 * Aplica la tarifa plana vigente en producción:
 *   - Limpia el recargo por km de config_zonas (causa real de que el envío
 *     cambiara de precio entre pedidos).
 *   - Estándar $40 / Express $60, cobertura 5 km.
 *   - pago_repartidor = 100% del envío (el repartidor se queda con la tarifa).
 * Los montos se leen de config/precios.js para no tener dos fuentes de verdad.
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const { TARIFAS_CLIENTE, COMISION_FLAT, MAX_DISTANCE_KM } = require('../config/precios');

(async () => {
  const q = (s) => sequelize.query(s, { type: sequelize.QueryTypes.SELECT });
  const cols = 'tipo_envio, max_km, fee_base, surcharge_inicio_km, surcharge_por_km';
  console.log('ANTES  zonas:', await q(`SELECT ${cols} FROM config_zonas ORDER BY tipo_envio`));
  console.log('ANTES  comisiones:', await q('SELECT metodo_pago, tipo_envio, comision_plataforma, pago_repartidor FROM config_comisiones ORDER BY tipo_envio, metodo_pago'));

  await sequelize.query('UPDATE config_zonas SET surcharge_inicio_km = NULL, surcharge_por_km = NULL');
  await sequelize.query(
    `UPDATE config_zonas SET fee_base = :fee, max_km = :km WHERE tipo_envio = 'standard'`,
    { replacements: { fee: TARIFAS_CLIENTE.STANDARD, km: MAX_DISTANCE_KM } });
  await sequelize.query(
    `UPDATE config_zonas SET fee_base = :fee, max_km = :km WHERE tipo_envio = 'express'`,
    { replacements: { fee: TARIFAS_CLIENTE.EXPRESS, km: MAX_DISTANCE_KM } });
  await sequelize.query(
    `UPDATE config_comisiones SET pago_repartidor = :pago, comision_plataforma = :com WHERE tipo_envio = 'standard'`,
    { replacements: { pago: TARIFAS_CLIENTE.STANDARD, com: COMISION_FLAT } });
  await sequelize.query(
    `UPDATE config_comisiones SET pago_repartidor = :pago, comision_plataforma = :com WHERE tipo_envio = 'express'`,
    { replacements: { pago: TARIFAS_CLIENTE.EXPRESS, com: COMISION_FLAT } });

  console.log('DESPUÉS zonas:', await q(`SELECT ${cols} FROM config_zonas ORDER BY tipo_envio`));
  console.log('DESPUÉS comisiones:', await q('SELECT metodo_pago, tipo_envio, comision_plataforma, pago_repartidor FROM config_comisiones ORDER BY tipo_envio, metodo_pago'));
  await sequelize.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
