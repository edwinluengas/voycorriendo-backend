/**
 * Cálculo económico — VoyCorriendo
 * Las tarifas se cargan desde config_zonas y config_comisiones en DB (cache 5 min).
 * Fallback a valores locales si DB no responde.
 */
const {
  TARIFAS_CLIENTE, PAGO_REPARTIDOR, MAX_DISTANCE_KM,
} = require('../config/precios');

const r2 = (n) => Math.round(n * 100) / 100;

// ─── Costo de envío al cliente (zona-based) ───────────────
// Retorna { zona, costo, fueraDeCobertura, desglose }
const calcularCostoEnvio = async ({ distanciaKm, tipoEnvio = 'standard' }) => {
  try {
    const { getZona } = require('../services/config.service');
    const zona = await getZona(tipoEnvio);
    if (zona) {
      const maxKm = Number(zona.max_km);
      if (distanciaKm == null || distanciaKm > maxKm) {
        return { zona: null, costo: 0, fueraDeCobertura: true, desglose: {} };
      }
      let costo = Number(zona.fee_base);
      if (zona.surcharge_inicio_km != null && distanciaKm > Number(zona.surcharge_inicio_km)) {
        const excedente = distanciaKm - Number(zona.surcharge_inicio_km);
        costo += excedente * Number(zona.surcharge_por_km);
        costo = r2(costo);
      }
      return {
        zona: distanciaKm <= 2 ? 'A' : distanciaKm <= 3 ? 'B' : 'C',
        costo,
        fueraDeCobertura: false,
        desglose: { base: Number(zona.fee_base), tipoEnvio, distanciaKm },
      };
    }
  } catch (e) {
    console.warn('[precios] Usando fallback (config.service falló):', e.message);
  }

  // Fallback a config local
  const maxFallback = tipoEnvio === 'express' ? 4 : MAX_DISTANCE_KM;
  if (distanciaKm == null || distanciaKm > maxFallback) {
    return { zona: null, costo: 0, fueraDeCobertura: true, desglose: {} };
  }
  const costoFallback = tipoEnvio === 'express' ? TARIFAS_CLIENTE.EXPRESS : TARIFAS_CLIENTE.STANDARD;
  return {
    zona: distanciaKm <= 2 ? 'A' : 'B',
    costo: costoFallback,
    fueraDeCobertura: false,
    desglose: { flat: costoFallback, tipoEnvio },
  };
};

// ─── Distancia máxima permitida por tipo de envío ────────
const getMaxKm = async (tipoEnvio = 'standard') => {
  try {
    const { getZona } = require('../services/config.service');
    const zona = await getZona(tipoEnvio);
    if (zona) return Number(zona.max_km);
  } catch (_) {}
  return tipoEnvio === 'express' ? 4 : MAX_DISTANCE_KM;
};

module.exports = {
  calcularCostoEnvio,
  getMaxKm,
  MAX_DISTANCE_KM,
};
