const cron = require('node-cron');
const { sequelize } = require('../config/database');
const tg = require('../services/telegram.service');
const { enviarEmail } = require('../services/email.service');

// Avisa a Edwin UNA sola vez cuando entra el primer pedido real de la
// plataforma. Antes lo hacía un script en su PC (voycorriendo-ops), que no
// vigilaba nada con la computadora apagada.
//
// "Real" = cliente que no es la cuenta de prueba de Edwin ni una cuenta
// interna de tests (teléfono 00000000xx).
const CLAVE = 'primer_pedido_real';
const CLIENTE_PRUEBA = '02f1564a-158d-441b-8ac5-c8ba08b5f54d';
const AVISAR_A = process.env.AVISO_PRIMER_PEDIDO_EMAIL || 'edwinluengas1979@gmail.com';

async function revisarPrimerPedido() {
  const [ya] = await sequelize.query('SELECT 1 FROM avisos_unicos WHERE clave = :clave',
    { type: 'SELECT', replacements: { clave: CLAVE } });
  if (ya) return false;

  const [p] = await sequelize.query(`
    SELECT p.numero, p.estado, p.total, p.metodo_pago, p.tipo_envio, p.ciudad, p.creado_en,
           n.nombre negocio, u.nombre cliente
      FROM pedidos p
      JOIN usuarios u ON u.id = p.cliente_id
      LEFT JOIN negocios n ON n.id = p.negocio_id
     WHERE p.cliente_id <> :prueba AND u.telefono NOT LIKE '00000000%'
     ORDER BY p.creado_en ASC LIMIT 1`,
  { type: 'SELECT', replacements: { prueba: CLIENTE_PRUEBA } });
  if (!p) return false;

  // Se reclama la marca ANTES de avisar: si hay dos réplicas corriendo, solo
  // la que logra insertar manda el aviso.
  const [, filas] = await sequelize.query(
    `INSERT INTO avisos_unicos (clave, detalle) VALUES (:clave, :detalle) ON CONFLICT (clave) DO NOTHING`,
    { replacements: { clave: CLAVE, detalle: p.numero } });
  if (!filas) return false;

  const hora = new Date(p.creado_en).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  const resumen = `🎉 PRIMER PEDIDO REAL en VoyCorriendo\n${p.numero} — ${p.negocio} (${p.ciudad})\n`
    + `Cliente: ${p.cliente}\n$${p.total} · ${p.metodo_pago} · ${p.tipo_envio}\nEstado: ${p.estado}\nCreado: ${hora}`;

  await tg.enviarAdmin(resumen);
  await enviarEmail({ para: AVISAR_A, asunto: `🎉 Primer pedido real: ${p.numero} (${p.negocio})`, texto: resumen });
  console.log(`[PrimerPedido] Aviso enviado: ${p.numero}`);
  return true;
}

function iniciarJobPrimerPedido() {
  cron.schedule('*/2 * * * *', async () => {
    try {
      await revisarPrimerPedido();
    } catch (e) {
      console.error('[PrimerPedido] Error:', e.message);
    }
  });
  console.log('[PrimerPedido] Job iniciado — avisa una vez del primer pedido real, revisa cada 2 min.');
}

module.exports = { iniciarJobPrimerPedido, revisarPrimerPedido };
