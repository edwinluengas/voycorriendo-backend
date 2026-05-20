const { RestaurantToken, DriverPayment, PlatformRevenue } = require('../models');

const FEE_EXPRESS        = 50;
const FEE_STANDARD       = 25;
const ZONA_PREMIUM_EXTRA = 5;
const TOKEN_FLAT_FEE     = 30;   // cuando el restaurante no tiene tokens
const PAGO_DAILY         = 22;
const PAGO_WEEKLY        = 28;
const COSTO_TX_DAILY     = 1.50;
const COSTO_TX_WEEKLY    = 0.20;
const GATEWAY_PCT        = 0.03;

const calcularFeeCliente = ({ tipoEnvio, zonaPremium }) => {
  const base = tipoEnvio === 'express' ? FEE_EXPRESS : FEE_STANDARD;
  return base + (zonaPremium ? ZONA_PREMIUM_EXTRA : 0);
};

const calcularPagoRepartidor = (tier) =>
  tier === 'daily' ? PAGO_DAILY : PAGO_WEEKLY;

// Determina si las coordenadas de entrega son zona premium
// (Zicatela o La Punta, Puerto Escondido)
const esZonaPremium = ({ lat, lng }) => {
  if (!lat || !lng) return false;
  const zonas = [
    { latMin: 15.840, latMax: 15.858, lngMin: -97.060, lngMax: -97.040 }, // Zicatela
    { latMin: 15.835, latMax: 15.848, lngMin: -97.095, lngMax: -97.075 }, // La Punta
  ];
  return zonas.some(
    z => lat >= z.latMin && lat <= z.latMax && lng >= z.lngMin && lng <= z.lngMax,
  );
};

// Descuenta 1 token del restaurante. Si no tiene, retorna el cargo flat.
// Devuelve { tokenValue, useFlatFee }
const consumirToken = async (restaurantId) => {
  const token = await RestaurantToken.findOne({
    where: { restaurant_id: restaurantId },
    order: [['expires_at', 'ASC']],
  });

  const ahora = new Date();

  if (!token || token.tokens_remaining <= 0 || token.expires_at < ahora) {
    return { tokenValue: TOKEN_FLAT_FEE, useFlatFee: true };
  }

  token.tokens_remaining -= 1;
  await token.save();

  const valores = { starter: 21, pro: 20, elite: 19 };
  return { tokenValue: valores[token.pack_type] ?? 20, useFlatFee: false };
};

// Llamar cuando un pedido pasa a 'entregado'.
// Registra el pago al repartidor y la ganancia de la plataforma.
const procesarEntrega = async ({ pedido, repartidor }) => {
  const { tokenValue, useFlatFee } = await consumirToken(pedido.negocio_id);
  const tier         = repartidor.tier;
  const feeCliente   = parseFloat(pedido.fee_cliente || 0);
  const pagoRepa     = calcularPagoRepartidor(tier);
  const txCosto      = tier === 'daily' ? COSTO_TX_DAILY : COSTO_TX_WEEKLY;
  const gatewayFee   = parseFloat((feeCliente * GATEWAY_PCT).toFixed(2));
  const netRevenue   = parseFloat(
    (tokenValue + feeCliente - pagoRepa - txCosto - gatewayFee).toFixed(2),
  );

  // Pago al repartidor
  const scheduledAt = tier === 'daily'
    ? new Date(Date.now() + 2 * 60 * 60 * 1000)   // 2 horas
    : proximoViernes();

  await DriverPayment.create({
    driver_id:    repartidor.id,
    order_id:     pedido.id,
    amount:       pagoRepa,
    tier,
    status:       'pending',
    scheduled_at: scheduledAt,
  });

  // Revenue de la plataforma
  await PlatformRevenue.create({
    order_id:         pedido.id,
    token_value:      tokenValue,
    client_fee:       feeCliente,
    driver_payout:    pagoRepa,
    transaction_cost: txCosto,
    gateway_fee:      gatewayFee,
    net_revenue:      netRevenue,
    tier,
  });

  return { pagoRepa, tokenValue, useFlatFee, netRevenue };
};

const proximoViernes = () => {
  const d = new Date();
  const diasHastaViernes = (5 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diasHastaViernes);
  d.setHours(9, 0, 0, 0);
  return d;
};

module.exports = { calcularFeeCliente, esZonaPremium, procesarEntrega, calcularPagoRepartidor };
