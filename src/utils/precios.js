/**
 * Utilidades de cálculo económico — Modelo Flat Rate VoyCorriendo
 *
 * Tarifa plana: $35 cliente / $35 negocio / $35 repartidor (standard)
 *               $60 cliente / $35 negocio / $50 repartidor (express)
 * Mínimo de pedido: $100 MXN en productos
 */
const {
  TARIFAS_CLIENTE, COMISION_FLAT, PAGO_REPARTIDOR,
  MAX_DISTANCE_KM, VOYTOKENS, ZONAS, HORA_PICO_RANGOS,
} = require('../config/precios');

const r2 = (n) => Math.round(n * 100) / 100;

// Compatibilidad legacy: zona según distancia (solo para cobertura)
const calcularZona = (distanciaKm) => {
  if (!Number.isFinite(distanciaKm) || distanciaKm < 0) return null;
  if (distanciaKm > MAX_DISTANCE_KM) return null;
  if (distanciaKm <= ZONAS.A.hasta) return 'A';
  if (distanciaKm <= ZONAS.B.hasta) return 'B';
  if (distanciaKm <= ZONAS.C.hasta) return 'C';
  return null;
};

const esHoraPico = (fecha = new Date()) => {
  const h = fecha.getHours();
  return HORA_PICO_RANGOS.some(({ desde, hasta }) => h >= desde && h < hasta);
};

// ─── Costo de envío al cliente (FLAT) ────────────────────
// Sin importar zona ni distancia: $35 standard / $60 express
const calcularCostoEnvio = ({ distanciaKm, tipoEnvio = 'standard' }) => {
  const zona = calcularZona(distanciaKm);
  if (!zona) return { zona: null, costo: 0, desglose: {}, fueraDeCobertura: true };
  const costo = tipoEnvio === 'express' ? TARIFAS_CLIENTE.EXPRESS : TARIFAS_CLIENTE.STANDARD;
  return {
    zona,
    costo,
    fueraDeCobertura: false,
    desglose: { flat: costo, tipoEnvio },
  };
};

// ─── Pago al repartidor (FLAT) ────────────────────────────
const calcularPagoRepartidor = ({ tipoEnvio = 'standard' }) => {
  const pago = tipoEnvio === 'express' ? PAGO_REPARTIDOR.EXPRESS : PAGO_REPARTIDOR.STANDARD;
  return { pago, desglose: { flat: pago, tipoEnvio } };
};

// ─── Comisión al negocio (FLAT) ───────────────────────────
// Siempre $35 por pedido, sin importar subtotal ni categoría
const calcularComision = () => {
  return { comision: COMISION_FLAT, flat: true };
};

// ─── Ganancia neta de la app ──────────────────────────────
// standard: $35 (cliente) + $35 (negocio) - $35 (repa) = $35
// express:  $60 (cliente) + $35 (negocio) - $50 (repa) = $45
const calcularGananciaApp = ({ costoEnvio, pagoRepartidor }) => {
  return r2(
    COMISION_FLAT +
    (Number(costoEnvio) || 0) -
    (Number(pagoRepartidor) || 0)
  );
};

// ─── VoyTokens para el cliente ────────────────────────────
// 1 token por cada $10 en productos. 35 tokens = envío gratis.
const calcularVoyTokens = (subtotal) => {
  return Math.floor(subtotal / VOYTOKENS.POR_PESO);
};

module.exports = {
  calcularZona,
  esHoraPico,
  calcularCostoEnvio,
  calcularPagoRepartidor,
  calcularComision,
  calcularGananciaApp,
  calcularVoyTokens,
  MAX_DISTANCE_KM,
};
