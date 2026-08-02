/**
 * Configuración económica de VoyCorriendo — Modelo Flat Rate
 * -----------------------------------------------------------
 * Modelo definitivo (v1.2.17):
 *   - FEE_PLATAFORMA: $35 MXN flat por pedido cobrado al restaurante
 *   - Envío: lo paga el CLIENTE y es ingreso del REPARTIDOR
 *     · Standard $40 | Express $60  (flat, NO depende de la distancia)
 *   - Pedido mínimo: $150 MXN en productos (sin envío)
 *   - Radio máximo: 5 km desde el restaurante a la dirección de entrega
 *   - Tope deuda restaurante: 15 pedidos en efectivo sin liquidar (bloqueo automático — ya NO es por monto)
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
// $40 estándar desde 2026-07-26: con $35 y cobertura de 5 km, la utilidad
// neta del repartidor en una entrega larga caía a $18.42 (~$32/hora, por
// debajo del salario mínimo por hora) una vez descontados gasolina,
// mantenimiento y depreciación de la moto. Con $40 queda en $23.42 (~$41/h)
// aun en el peor caso. Ver src/scripts/analisis-rentabilidad-repartidor.js
// — ahí está el modelo completo con sus supuestos, para recalcular si sube
// la gasolina o cambia el radio.
const TARIFAS_CLIENTE = {
  STANDARD:      num('FEE_STANDARD', 40),   // Envío estándar (flat)
  EXPRESS:       num('FEE_EXPRESS',  60),   // Envío express (flat)
  // Se conserva TARIFA_MINIMA_ENVIO para compatibilidad con cotizar
  TARIFA_MINIMA_ENVIO: num('TARIFA_MINIMA_ENVIO', 40),
};

// ─── 2. Comisión flat al negocio ────────────────────────────
const COMISION_FLAT = num('COMISION_NEGOCIO', 35);   // MXN fijo por pedido

// ─── 3. Pago flat al repartidor ─────────────────────────────
// El repartidor se queda con el 100% de la tarifa de envío que paga el
// cliente — por eso estos montos deben ser IDÉNTICOS a TARIFAS_CLIENTE
// (35/60). El 50 que había aquí para express era de un modelo viejo y
// generaba un descuadre de $10 cada vez que se usaba como fallback.
const PAGO_REPARTIDOR = {
  STANDARD: num('PAGO_REP_STANDARD', TARIFAS_CLIENTE.STANDARD),  // entrega estándar
  EXPRESS:  num('PAGO_REP_EXPRESS',  TARIFAS_CLIENTE.EXPRESS),   // entrega express
};

// ─── 3b. Métodos de pago habilitados ────────────────────────
// FASE DE PRUEBA REAL (2026-07-29, decisión del dueño): solo EFECTIVO. El
// pago con tarjeta queda desactivado hasta que él lo reactive — el código
// sigue completo y probado, solo no se ofrece ni se acepta.
//
// Para reactivar: variable de entorno METODOS_PAGO_ACTIVOS con la lista
// separada por comas, p. ej. `efectivo,tarjeta` o `efectivo,tarjeta,transferencia`.
// La app lee lo mismo desde /api/config-publica, así que basta cambiar la
// variable en Railway y reiniciar — no hace falta un build nuevo.
// Se lee en CADA consulta, no al cargar el módulo. Como constante, cambiar
// la variable en Railway no surtía efecto hasta reiniciar el proceso — y
// eso ya nos mordió: el puente de correo siguió redirigiendo a un buzón
// personal después de darlo por apagado. Un interruptor que promete
// 'se cambia sin desplegar' tiene que cumplirlo.
const metodosPagoActivos = () => (process.env.METODOS_PAGO_ACTIVOS || 'efectivo')
  .split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);

const metodoPagoActivo = (metodo) => metodosPagoActivos().includes(String(metodo || '').toLowerCase());

// ─── 4. Reglas de negocio ───────────────────────────────────
const PEDIDO_MINIMO     = num('PEDIDO_MINIMO',      150);  // mínimo en productos (MXN)
// Tope de EFECTIVO: se mide sobre el subtotal de PRODUCTOS (el envío se suma
// encima). $700 desde 2026-07-29 — antes $500, y el número vivía duplicado
// en pagos.service (env var) y hardcodeado en pedidosController, así que
// cambiarlo en un lado dejaba el otro desalineado.
const LIMITE_EFECTIVO   = num('LIMITE_EFECTIVO',    700);
const MAX_DISTANCE_KM   = num('MAX_DISTANCE_KM',    6.5);  // radio máximo de entrega
// 6.5 km desde 2026-07-31: la distancia ya no se mide en línea recta sino
// corregida por FACTOR_RUTA_REAL (1.3), así que 5 km "rectos" de antes
// equivalen a ~6.5 km de recorrido estimado. Se subió el número para
// conservar EXACTAMENTE la misma área que se venía atendiendo — lo que
// cambia es que ahora el km que se muestra es el que de verdad se maneja.
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
// Exige que las calificaciones vengan de al menos esta cantidad de
// CLIENTES DISTINTOS — evita que un solo cliente, pidiendo varias veces al
// mismo repartidor y calificando 1★ cada vez, fuerce por sí solo una baja
// permanente (que es irreversible salvo revisión de admin).
const CLIENTES_DISTINTOS_MIN_PARA_BAJA = num('CLIENTES_DISTINTOS_MIN_PARA_BAJA', 4);

// ─── 4b. Modelo de liquidación cuenta concentradora (2026-07-23) ──
// Comisión real de Mercado Pago (verificada contra pago real en producción:
// $185 → $12.13 exacto con liberación inmediata) + IVA. Se prorratea entre
// las partes según su ingreso bruto en la transacción.
const MP_FEE_PCT  = num('MP_FEE_PCT',  0.0349);
const MP_FEE_FIJO = num('MP_FEE_FIJO', 4.00);
const IVA_PCT     = num('IVA_PCT',     0.16);
// Pedidos perdidos: default 50% restaurante / 50% plataforma. Si un admin
// determina pérdida INTENCIONAL del repartidor: 60% repartidor / 40%
// plataforma / 0% restaurante.
const PCT_PERDIDA_RESTAURANTE     = num('PCT_PERDIDA_RESTAURANTE', 0.50);
const PCT_PERDIDA_REP_INTENCIONAL = num('PCT_PERDIDA_REP_INTENCIONAL', 0.60);
// Bloqueo permanente del repartidor (cuenta + vehículo) al superar este
// número de pedidos perdidos activos (es decir, al 3ro con default 2).
const LIMITE_PEDIDOS_PERDIDOS = num('LIMITE_PEDIDOS_PERDIDOS', 2);
// Pago diario anticipado: 5% de descuento sobre el saldo pendiente (ambos
// roles). Reemplaza el fee fijo de $10 anterior.
const PCT_DESCUENTO_PAGO_DIARIO = num('PCT_DESCUENTO_PAGO_DIARIO', 0.05);

// ─── 5. Bonos al repartidor — NO VIGENTES ───────────────────
// Hoy NO se pagan bonos de ningún tipo (confirmado por el dueño 2026-07-26).
// Este valor existe solo como configuración lista para el día que se activen;
// ningún código lo usa para pagar. Si se enciende de verdad, hay que
// implementar el pago Y volver a anunciarlo en la app (se quitó de
// TierScreen para no prometer un ingreso inexistente).
const BONOS = {
  METAS_10: num('BONUS_METAS_10', 0),
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
  metodosPagoActivos,
  metodoPagoActivo,
  LIMITE_EFECTIVO,
  PEDIDO_MINIMO,
  MAX_DISTANCE_KM,
  LIMITE_PEDIDOS_DEUDA,
  AVISO_PEDIDOS_DEUDA,
  FEE_RETIRO_DIARIO,
  FEE_RETIRO_DIARIO_NEGOCIO,
  MP_FEE_PCT,
  MP_FEE_FIJO,
  IVA_PCT,
  PCT_PERDIDA_RESTAURANTE,
  PCT_PERDIDA_REP_INTENCIONAL,
  LIMITE_PEDIDOS_PERDIDOS,
  PCT_DESCUENTO_PAGO_DIARIO,
  CALIFICACIONES_MIN_PARA_BAJA,
  CALIFICACION_MIN_PROMEDIO,
  CLIENTES_DISTINTOS_MIN_PARA_BAJA,
  BONOS,
  // Legacy exports para compatibilidad
  HORA_PICO_RANGOS,
  ZONAS,
  COMISIONES,
};
