/**
 * Utilidades de cálculo económico (modelo tipo Rappi).
 *
 * - calcularZona: mapea km → 'A' | 'B' | 'C' (o null si supera el máximo)
 * - calcularCostoEnvio: tarifa dinámica por zona + hora pico + clima
 * - calcularPagoRepartidor: pago fijo por tramo + propina
 * - calcularComision: % según categoría (con override por negocio)
 * - calcularGananciaApp: ganancia neta de VoyCorriendo por el pedido
 */
const {
  TARIFAS_CLIENTE, HORA_PICO_RANGOS, PAGO_REPARTIDOR,
  COMISIONES, ZONAS, MAX_DISTANCE_KM,
} = require('../config/precios');

// Redondear a centavos (2 decimales)
const r2 = (n) => Math.round(n * 100) / 100;

// ─── Zonas ────────────────────────────────────────────────
const calcularZona = (distanciaKm) => {
  if (!Number.isFinite(distanciaKm) || distanciaKm < 0) return null;
  if (distanciaKm > MAX_DISTANCE_KM) return null;            // fuera de cobertura
  if (distanciaKm <= ZONAS.A.hasta) return 'A';
  if (distanciaKm <= ZONAS.B.hasta) return 'B';
  if (distanciaKm <= ZONAS.C.hasta) return 'C';
  return null;
};

// ─── Hora pico ────────────────────────────────────────────
const esHoraPico = (fecha = new Date()) => {
  const h = fecha.getHours();
  return HORA_PICO_RANGOS.some(({ desde, hasta }) => h >= desde && h < hasta);
};

// ─── Costo de envío al cliente ────────────────────────────
// Fórmula: max(TARIFA_MINIMA_ENVIO, base_zona + hora_pico + clima - descuento)
// Regla de Edwin (2026-04-19): $25 MXN es el PISO ABSOLUTO de la tarifa.
// Nunca se cobra menos que eso, aunque haya promoción o descuento.
const calcularCostoEnvio = ({ distanciaKm, fecha, climaExtremo = false, descuento = 0 }) => {
  const zona = calcularZona(distanciaKm);
  if (!zona) return { zona: null, costo: 0, desglose: { base: 0 }, fueraDeCobertura: true };

  const base = ZONAS[zona].fee;
  const recargoHora  = esHoraPico(fecha) ? TARIFAS_CLIENTE.RECARGO_HORA_PICO : 0;
  const recargoClima = climaExtremo      ? TARIFAS_CLIENTE.RECARGO_CLIMA    : 0;
  const desc = Math.max(0, Number(descuento) || 0);

  const bruto = base + recargoHora + recargoClima - desc;
  const minimo = TARIFAS_CLIENTE.TARIFA_MINIMA_ENVIO;
  const aplicaMinimo = bruto < minimo;
  const costo = r2(aplicaMinimo ? minimo : bruto);

  return {
    zona,
    costo,
    fueraDeCobertura: false,
    desglose: {
      base,
      recargoHora,
      recargoClima,
      descuento: desc,
      minimo,
      aplicaMinimo,
    },
  };
};

// ─── Pago al repartidor ───────────────────────────────────
// Fórmula: base_por_distancia + bonos + propina
const calcularPagoRepartidor = ({ distanciaKm, propina = 0, bonos = 0 }) => {
  let base;
  if (distanciaKm <= 2)      base = PAGO_REPARTIDOR.CORTA;
  else if (distanciaKm <= 5) base = PAGO_REPARTIDOR.MEDIA;
  else                       base = PAGO_REPARTIDOR.LARGA;

  const pago = r2(base + bonos + (Number(propina) || 0));
  return {
    pago,
    desglose: { base, bonos, propina: Number(propina) || 0 },
  };
};

// ─── Comisión al negocio ──────────────────────────────────
// Si el negocio tiene override en `comision_porcentaje`, se respeta;
// si no, usamos el default por categoría.
const calcularComision = ({ subtotal, categoria, comisionOverride }) => {
  const porcentajeDefault = COMISIONES[categoria] ?? COMISIONES.otro;
  const porcentaje =
    comisionOverride != null && !Number.isNaN(Number(comisionOverride))
      ? Number(comisionOverride)
      : porcentajeDefault;
  const comision = r2((subtotal * porcentaje) / 100);
  return { comision, porcentaje };
};

// ─── Ganancia neta de la app ──────────────────────────────
// ganancia_app = comision + (costo_envio - pago_repartidor)
const calcularGananciaApp = ({ comision, costoEnvio, pagoRepartidor }) => {
  return r2(
    (Number(comision) || 0) +
    (Number(costoEnvio) || 0) -
    (Number(pagoRepartidor) || 0)
  );
};

module.exports = {
  calcularZona,
  esHoraPico,
  calcularCostoEnvio,
  calcularPagoRepartidor,
  calcularComision,
  calcularGananciaApp,
  MAX_DISTANCE_KM,
};
