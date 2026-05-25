/**
 * Configuración económica de VoyCorriendo — Modelo Flat Rate
 * -----------------------------------------------------------
 * Modelo simplificado de tarifa plana:
 *   - Cliente: $35 MXN por entrega (standard) | $60 MXN (express)
 *   - Negocio: $35 MXN flat por pedido (no porcentaje)
 *   - Repartidor: $35 MXN flat por entrega (standard) | $50 MXN (express)
 *   - VoyCorriendo: $35 neto por pedido standard
 *   - Pedido mínimo: $100 MXN en productos
 *
 * VoyTokens — Programa de lealtad:
 *   - Cliente gana 1 VoyToken por cada $10 en productos
 *   - 35 tokens = 1 envío gratis
 *   - ~3-4 pedidos promedio para obtener envío gratis
 */

// Pequeño helper: lee una variable de entorno como número, o usa el default
const num = (clave, def) => {
  const raw = process.env[clave];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

// ─── 1. Tarifas flat al cliente ─────────────────────────────
const TARIFAS_CLIENTE = {
  STANDARD:      num('FEE_STANDARD', 35),   // Envío estándar (flat)
  EXPRESS:       num('FEE_EXPRESS',  60),   // Envío express (flat)
  // Se conserva TARIFA_MINIMA_ENVIO para compatibilidad con cotizar
  TARIFA_MINIMA_ENVIO: num('TARIFA_MINIMA_ENVIO', 35),
};

// ─── 2. Comisión flat al negocio ────────────────────────────
const COMISION_FLAT = num('COMISION_NEGOCIO', 35);   // MXN fijo por pedido

// ─── 3. Pago flat al repartidor ─────────────────────────────
const PAGO_REPARTIDOR = {
  STANDARD: num('PAGO_REP_STANDARD', 35),  // entrega estándar
  EXPRESS:  num('PAGO_REP_EXPRESS',  50),  // entrega express (repartidor prioriza)
};

// ─── 4. Reglas de negocio ───────────────────────────────────
const PEDIDO_MINIMO = num('PEDIDO_MINIMO', 100);  // mínimo en productos (MXN)
const MAX_DISTANCE_KM = num('MAX_DISTANCE_KM', 6);

// ─── 5. VoyTokens — Programa de lealtad para clientes ───────
// 1 token por cada $10 gastados en productos
// 35 tokens = 1 envío gratis ($35)
// Aproximadamente cada 3-4 pedidos de $100 = 1 envío gratis
const VOYTOKENS = {
  POR_PESO:   num('TOKENS_POR_PESO', 10),   // cada $10 → 1 token
  ENVIO_GRATIS: num('TOKENS_ENVIO', 35),    // tokens para canjear envío gratis
};

// ─── 6. VoyPass — Suscripción mensual (próximamente) ────────
const VOYPASS = {
  PRECIO_MXN:  num('VOYPASS_PRECIO', 99),   // $99/mes = envíos gratis todo el mes
};

// ─── 7. Bonos al repartidor (fase 2) ────────────────────────
const BONOS = {
  METAS_10: num('BONUS_METAS_10', 50),  // bono al completar 10 pedidos en el día
};

// Legacy: Zonas se mantienen solo para validar cobertura por distancia
const HORA_PICO_RANGOS = [
  { desde: 12, hasta: 14 },
  { desde: 19, hasta: 22 },
];
const ZONAS = {
  A: { desde: 0, hasta: 2,  fee: TARIFAS_CLIENTE.STANDARD },
  B: { desde: 2, hasta: 5,  fee: TARIFAS_CLIENTE.STANDARD },
  C: { desde: 5, hasta: 10, fee: TARIFAS_CLIENTE.STANDARD },
};
const COMISIONES = { default: COMISION_FLAT };

module.exports = {
  TARIFAS_CLIENTE,
  COMISION_FLAT,
  PAGO_REPARTIDOR,
  PEDIDO_MINIMO,
  MAX_DISTANCE_KM,
  VOYTOKENS,
  VOYPASS,
  BONOS,
  // Legacy exports para compatibilidad
  HORA_PICO_RANGOS,
  ZONAS,
  COMISIONES,
};
