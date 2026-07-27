/**
 * Cálculo económico — VoyCorriendo
 *
 * TARIFA PLANA (decisión del dueño, 2026-07-26): el envío NUNCA depende de la
 * distancia. Standard $35, Express $60, punto. La DB (`config_zonas`) se usa
 * SOLO para la cobertura máxima en km; las columnas `surcharge_inicio_km` /
 * `surcharge_por_km` quedaron desactivadas y ya NO se leen — eran la causa
 * real de que la tarifa cambiara entre pedidos (fee = 35 + $5 por cada km
 * arriba de 3, así que un pedido a 4.7 km cobraba $43.55 en vez de $35).
 * Si alguien vuelve a poblar esas columnas en DB, este código las ignora.
 *
 * La fuente de verdad de los montos es `config/precios.js` (env-overridable
 * con FEE_STANDARD / FEE_EXPRESS).
 */
const {
  TARIFAS_CLIENTE, MAX_DISTANCE_KM,
} = require('../config/precios');

// ─── Costo de envío al cliente (FLAT por tipo de envío) ───
// Retorna { zona, costo, fueraDeCobertura, desglose }
const calcularCostoEnvio = async ({ distanciaKm, tipoEnvio = 'standard' }) => {
  if (tipoEnvio === 'pickup') {
    return { zona: null, costo: 0, fueraDeCobertura: false, desglose: { flat: 0, tipoEnvio } };
  }

  const maxKm = await getMaxKm(tipoEnvio);
  if (distanciaKm == null || distanciaKm > maxKm) {
    return { zona: null, costo: 0, fueraDeCobertura: true, desglose: {} };
  }

  const costo = tipoEnvio === 'express' ? TARIFAS_CLIENTE.EXPRESS : TARIFAS_CLIENTE.STANDARD;
  return {
    zona: distanciaKm <= 2 ? 'A' : distanciaKm <= 3 ? 'B' : 'C',
    costo,
    fueraDeCobertura: false,
    desglose: { flat: costo, tipoEnvio, distanciaKm },
  };
};

// ─── Distancia máxima permitida por tipo de envío ────────
const getMaxKm = async (tipoEnvio = 'standard') => {
  try {
    const { getZona } = require('../services/config.service');
    const zona = await getZona(tipoEnvio);
    if (zona) return Number(zona.max_km);
  } catch (e) {
    console.warn('[precios] Usando cobertura fallback (config.service falló):', e.message);
  }
  return MAX_DISTANCE_KM;
};

module.exports = {
  calcularCostoEnvio,
  getMaxKm,
  MAX_DISTANCE_KM,
};
