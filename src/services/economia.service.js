const {
  TARIFAS_CLIENTE, COMISION_FLAT, PAGO_REPARTIDOR,
} = require('../config/precios');

// ─── Flat-rate fee al cliente ─────────────────────────────
const calcularFeeCliente = ({ tipoEnvio }) =>
  tipoEnvio === 'express' ? TARIFAS_CLIENTE.EXPRESS : TARIFAS_CLIENTE.STANDARD;

// ─── Flat-rate pago al repartidor ─────────────────────────
const calcularPagoRepartidor = ({ tipoEnvio }) =>
  tipoEnvio === 'express' ? PAGO_REPARTIDOR.EXPRESS : PAGO_REPARTIDOR.STANDARD;

// ─── Ganancia neta de la plataforma ───────────────────────
// standard: $35 (cliente) + $35 (negocio) - $35 (repa) = $35
// express:  $60 (cliente) + $35 (negocio) - $50 (repa) = $45
const calcularGananciaApp = ({ feeCliente, pagoRepartidor }) =>
  Math.round((COMISION_FLAT + feeCliente - pagoRepartidor) * 100) / 100;

// ─── Procesar entrega (modelo flat-rate) ──────────────────
// Se llama cuando un pedido pasa a 'entregado'.
// No consume tokens — solo registra los números para auditoría.
const procesarEntrega = async ({ pedido, repartidor }) => {
  const tipoEnvio  = pedido.tipo_envio || 'standard';
  const feeCliente = parseFloat(pedido.fee_cliente || 0);
  const pagoRepa   = calcularPagoRepartidor({ tipoEnvio });
  const netRevenue = calcularGananciaApp({ feeCliente, pagoRepartidor: pagoRepa });

  console.log(
    `[economia] Pedido ${pedido.numero} entregado` +
    ` | fee_cliente: $${feeCliente}` +
    ` | comision_negocio: $${COMISION_FLAT}` +
    ` | pago_repartidor: $${pagoRepa}` +
    ` | ganancia_app: $${netRevenue}`,
  );

  return { pagoRepa, netRevenue };
};

// Legacy: zonas premium eliminadas en modelo flat-rate
const esZonaPremium = () => false;

module.exports = { calcularFeeCliente, esZonaPremium, procesarEntrega, calcularPagoRepartidor };
