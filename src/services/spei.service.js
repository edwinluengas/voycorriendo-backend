/**
 * Servicio de pagos SPEI semanales a repartidores tier "weekly".
 * Se ejecuta cada viernes. Agrupa DriverPayments pendientes por
 * repartidor, calcula el total y dispara la transferencia SPEI.
 *
 * La función enviarSPEI() es un stub; sustituirla por la integración
 * real con STP (Sistema de Transferencias y Pagos) o el banco elegido.
 */

const { DriverPayment, Repartidor, Usuario } = require('../models');
const { Op } = require('sequelize');
const axios = require('axios');

// ─── Stub SPEI (reemplazar con STP u OpenPay en producción) ───
const enviarSPEI = async ({ clabe, banco, monto, concepto, referencia }) => {
  const STP_URL    = process.env.STP_BASE_URL;
  const STP_KEY    = process.env.STP_API_KEY;
  const STP_CUENTA = process.env.STP_CUENTA_ORIGEN;

  if (!STP_URL || !STP_KEY) {
    console.log(`[SPEI STUB] $${monto.toFixed(2)} → CLABE ${clabe} (${banco || 'N/A'}) | ${concepto} | ref: ${referencia}`);
    return { ok: true, tracking_id: `STUB-${referencia}` };
  }

  try {
    const { data } = await axios.post(
      `${STP_URL}/ordenaPago`,
      {
        claveRastreo: referencia,
        conceptoPago: concepto,
        cuentaBeneficiario: clabe,
        institucionContraparte: banco,
        monto,
        nombreBeneficiario: concepto,
        cuentaOrdenante: STP_CUENTA,
        tipoPago: 1,
      },
      { headers: { Authorization: `Bearer ${STP_KEY}` } }
    );
    return { ok: true, tracking_id: data.id || referencia };
  } catch (err) {
    console.error('[SPEI] Error al enviar:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
};

// ─── Ejecutar pagos semanales ──────────────────────────────────
const ejecutarPagosSemanales = async () => {
  const pagos = await DriverPayment.findAll({
    where: { status: 'pending', tier: 'weekly' },
    include: [{
      model: Repartidor,
      include: [{ model: Usuario, attributes: ['nombre'] }],
    }],
  });

  if (!pagos.length) {
    console.log('[SPEI] Sin pagos semanales pendientes.');
    return { ejecutado_en: new Date(), total_repartidores: 0, resultados: [] };
  }

  // Agrupar por repartidor
  const porRepartidor = {};
  for (const pago of pagos) {
    const key = pago.driver_id;
    if (!porRepartidor[key]) {
      porRepartidor[key] = { repartidor: pago.Repartidor, pagos: [], total: 0 };
    }
    porRepartidor[key].pagos.push(pago);
    porRepartidor[key].total += parseFloat(pago.amount);
  }

  const resultados = [];
  const ahora = new Date();

  for (const [driver_id, { repartidor, pagos: lista, total }] of Object.entries(porRepartidor)) {
    const nombre = repartidor?.Usuario?.nombre || driver_id;

    if (!repartidor?.clabe_bancaria) {
      for (const p of lista) { p.status = 'failed'; await p.save(); }
      resultados.push({ driver_id, nombre, ok: false, motivo: 'Sin CLABE registrada', total });
      console.warn(`[SPEI] ${nombre}: sin CLABE, marcado como fallido.`);
      continue;
    }

    const referencia = `VCR-${ahora.toISOString().slice(0, 10)}-${driver_id.slice(0, 8).toUpperCase()}`;
    const resultado  = await enviarSPEI({
      clabe:     repartidor.clabe_bancaria,
      banco:     repartidor.banco,
      monto:     total,
      concepto:  `VoyCorriendo ${lista.length} entregas`,
      referencia,
    });

    for (const p of lista) {
      p.status  = resultado.ok ? 'paid' : 'failed';
      p.paid_at = resultado.ok ? ahora  : null;
      await p.save();
    }

    resultados.push({
      driver_id,
      nombre,
      ok:          resultado.ok,
      total,
      entregas:    lista.length,
      tracking_id: resultado.tracking_id,
      motivo:      resultado.error,
    });
  }

  const exitosos = resultados.filter(r => r.ok).length;
  console.log(`[SPEI] Pagos semanales completados: ${exitosos}/${resultados.length} repartidores.`);

  return {
    ejecutado_en:       ahora,
    total_repartidores: resultados.length,
    exitosos,
    fallidos:           resultados.length - exitosos,
    resultados,
  };
};

// ─── Preview: pagos pendientes sin ejecutar ────────────────────
const previsualizarPagosSemanales = async () => {
  const pagos = await DriverPayment.findAll({
    where: { status: 'pending', tier: 'weekly' },
    include: [{
      model: Repartidor,
      include: [{ model: Usuario, attributes: ['nombre'] }],
    }],
  });

  const porRepartidor = {};
  for (const pago of pagos) {
    const key = pago.driver_id;
    if (!porRepartidor[key]) {
      porRepartidor[key] = {
        driver_id: pago.driver_id,
        nombre:    pago.Repartidor?.Usuario?.nombre,
        clabe:     pago.Repartidor?.clabe_bancaria,
        banco:     pago.Repartidor?.banco,
        entregas:  0,
        total:     0,
      };
    }
    porRepartidor[key].entregas += 1;
    porRepartidor[key].total    += parseFloat(pago.amount);
  }

  return Object.values(porRepartidor);
};

module.exports = { ejecutarPagosSemanales, previsualizarPagosSemanales };
