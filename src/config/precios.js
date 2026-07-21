/**
 * Configuración económica de VoyCorriendo — Modelo Flat Rate
 * -----------------------------------------------------------
 * Modelo definitivo (v1.2.17):
 *   - FEE_PLATAFORMA: $35 MXN flat por pedido cobrado al restaurante
 *   - Envío: lo paga el CLIENTE y es ingreso del REPARTIDOR
 *     · Standard $35 | Express $60
 *   - Pedido mínimo: $150 MXN en productos (sin envío)
 *   - Radio máximo: 5 km desde el restaurante a la dirección de entrega
 *   - Tope deuda restaurante: $1,000 MXN (bloqueo automático)
 *   - Sin cargos de servicio al cliente. Sin envíos gratis. Sin tokens de cliente.
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
const PEDIDO_MINIMO     = num('PEDIDO_MINIMO',      150);  // mínimo en productos (MXN)
const MAX_DISTANCE_KM   = num('MAX_DISTANCE_KM',      5);  // radio máximo de entrega
// Bloqueo automático del restaurante: ya NO es por monto acumulado ($1,000
// antes) — ahora es por CANTIDAD de pedidos en efectivo sin liquidar. Al
// llegar a LIMITE_PEDIDOS_DEUDA se bloquea y debe transferir por SPEI lo
// que sume esa cantidad de pedidos (deuda_plataforma), sea cual sea el monto.
const LIMITE_PEDIDOS_DEUDA = num('LIMITE_PEDIDOS_DEUDA', 15);
const AVISO_PEDIDOS_DEUDA  = num('AVISO_PEDIDOS_DEUDA',  12);  // aviso antes del bloqueo
const FEE_RETIRO_DIARIO = num('FEE_RETIRO_DIARIO',   10);  // fee repartidor si retira fuera del viernes
const FEE_RETIRO_DIARIO_NEGOCIO = num('FEE_RETIRO_DIARIO_NEGOCIO', 10);  // fee negocio si retira fuera del viernes

// Baja permanente de repartidor por calificación reprobatoria
const CALIFICACIONES_MIN_PARA_BAJA = num('CALIFICACIONES_MIN_PARA_BAJA', 6);
const CALIFICACION_MIN_PROMEDIO    = num('CALIFICACION_MIN_PROMEDIO',    3);

// ─── 5. Bonos al repartidor (fase 2) ────────────────────────
const BONOS = {
  METAS_10: num('BONUS_METAS_10', 50),
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
  LIMITE_PEDIDOS_DEUDA,
  AVISO_PEDIDOS_DEUDA,
  FEE_RETIRO_DIARIO,
  FEE_RETIRO_DIARIO_NEGOCIO,
  CALIFICACIONES_MIN_PARA_BAJA,
  CALIFICACION_MIN_PROMEDIO,
  BONOS,
  // Legacy exports para compatibilidad
  HORA_PICO_RANGOS,
  ZONAS,
  COMISIONES,
};
