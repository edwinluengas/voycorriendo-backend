const {
  TARIFAS_CLIENTE, COMISION_FLAT, PAGO_REPARTIDOR,
} = require('../config/precios');
const PlatformRevenue = require('../models/PlatformRevenue');

// ─── Flat-rate fee al cliente ─────────────────────────────
const calcularFeeCliente = ({ tipoEnvio }) => {
  if (tipoEnvio === 'express') return TARIFAS_CLIENTE.EXPRESS;
  if (tipoEnvio === 'pickup')  return 0;
  return TARIFAS_CLIENTE.STANDARD;
};

// ─── Flat-rate pago al repartidor ─────────────────────────
const calcularPagoRepartidor = ({ tipoEnvio }) =>
  tipoEnvio === 'express' ? PAGO_REPARTIDOR.EXPRESS : PAGO_REPARTIDOR.STANDARD;

// ─── Ganancia neta de la plataforma ───────────────────────
// standard: $35 (cliente) + $35 (negocio) - $35 (repa) = $35
// express:  $60 (cliente) + $35 (negocio) - $50 (repa) = $45
const calcularGananciaApp = ({ feeCliente, pagoRepartidor }) =>
  Math.round((COMISION_FLAT + feeCliente - pagoRepartidor) * 100) / 100;

// ─── Procesar entrega (modelo flat-rate) ──────────────────
const procesarEntrega = async ({ pedido, repartidor }) => {
  const tipoEnvio  = pedido.tipo_envio || 'standard';
  const feeCliente = parseFloat(pedido.fee_cliente || 0);
  const pagoRepa   = calcularPagoRepartidor({ tipoEnvio });
  const netRevenue = calcularGananciaApp({ feeCliente, pagoRepartidor: pagoRepa });

  await PlatformRevenue.upsert({
    order_id:         pedido.id,
    client_fee:       feeCliente,
    driver_payout:    pagoRepa,
    net_revenue:      netRevenue,
    token_value:      0,
    transaction_cost: 0,
    gateway_fee:      0,
    tier:             tipoEnvio,
  });

  console.log(
    `[economia] Pedido ${pedido.numero} entregado` +
    ` | fee_cliente: $${feeCliente}` +
    ` | pago_repartidor: $${pagoRepa}` +
    ` | ganancia_app: $${netRevenue}`,
  );

  return { pagoRepa, netRevenue };
};

// Legacy: zonas premium eliminadas en modelo flat-rate
const esZonaPremium = () => false;

module.exports = { calcularFeeCliente, esZonaPremium, procesarEntrega, calcularPagoRepartidor };
