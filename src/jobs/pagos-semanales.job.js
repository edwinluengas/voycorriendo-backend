const cron = require('node-cron');
const { ejecutarPagosSemanales } = require('../services/spei.service');

// Cada viernes a las 10:00 AM hora de México (America/Mexico_City)
const EXPRESION_CRON = '0 10 * * 5';

const iniciarJobPagosSemanales = () => {
  cron.schedule(EXPRESION_CRON, async () => {
    console.log('[JOB] Iniciando pagos semanales SPEI...');
    try {
      const resultado = await ejecutarPagosSemanales();
      console.log(`[JOB] Pagos SPEI completados: ${resultado.exitosos}/${resultado.total_repartidores} repartidores pagados.`);
    } catch (err) {
      console.error('[JOB] Error en pagos semanales:', err.message);
    }
  }, { timezone: 'America/Mexico_City' });

  console.log('[JOB] Pagos semanales SPEI programados: viernes 10:00 AM (MX)');
};

module.exports = { iniciarJobPagosSemanales };
