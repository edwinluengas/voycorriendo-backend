/**
 * Configuración económica de VoyCorriendo
 * ----------------------------------------
 * Modelo tipo Rappi adaptado a Puerto Escondido, Oaxaca (ciudad piloto).
 * El esquema de zonas es por kilometros, asi que sirve para cualquier ciudad
 * que sumemos despues (Huatulco, Salina Cruz, etc.).
 * Todos los montos en PESOS MEXICANOS (MXN).
 * Conversión usada desde el modelo original en USD: ~$20 MXN / $1 USD.
 *
 * Los valores pueden sobreescribirse por variable de entorno para que
 * Edwin pueda ajustar precios sin redeploy cuando haga sus pruebas.
 */

// Pequeño helper: lee una variable de entorno como número, o usa el default
const num = (clave, def) => {
  const raw = process.env[clave];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

// ─── 1. Tarifas al cliente (costo de envío, en MXN) ────────
// Equivalente a "base_fee + zona_extra + demanda_extra + clima_extra"
// IMPORTANTE: TARIFA_MINIMA_ENVIO es el PISO ABSOLUTO del envío.
// Ningún pedido se cobra por debajo de este monto, sin importar la zona,
// promociones o descuentos aplicados.
const TARIFAS_CLIENTE = {
  TARIFA_MINIMA_ENVIO: num('TARIFA_MINIMA_ENVIO', 25),  // Piso absoluto de envío (MXN)
  ZONA_A_FEE:        num('ZONA_A_FEE',        25),   // 0-2 km  (≈ $1.25 USD)
  ZONA_B_FEE:        num('ZONA_B_FEE',        40),   // 2-5 km  (≈ $2.00 USD)
  ZONA_C_FEE:        num('ZONA_C_FEE',        55),   // 5-10 km (≈ $2.75 USD)
  RECARGO_HORA_PICO: num('RECARGO_HORA_PICO', 10),   // +$10 MXN en horas pico
  RECARGO_CLIMA:     num('RECARGO_CLIMA',      5),   // +$5 MXN con clima extremo
};

// Horas pico (12:00-14:00 comida / 19:00-22:00 cena) en zona horaria MX
const HORA_PICO_RANGOS = [
  { desde: 12, hasta: 14 },
  { desde: 19, hasta: 22 },
];

// ─── 2. Pago al repartidor (en MXN) ────────────────────────
// Equivalente a "base_por_distancia + bono_demanda + propina"
const PAGO_REPARTIDOR = {
  CORTA:   num('COURIER_PAY_SHORT',  20),  // ≤ 2 km  (≈ $1.00 USD)
  MEDIA:   num('COURIER_PAY_MEDIUM', 30),  // 2-5 km  (≈ $1.50 USD)
  LARGA:   num('COURIER_PAY_LONG',   45),  // > 5 km  (≈ $2.25 USD)
};

// ─── 3. Comisiones por categoría de negocio (% del subtotal) ───
// El negocio puede tener un override en negocio.comision_porcentaje;
// si viene 0/null, cae a estos defaults por categoría.
const COMISIONES = {
  restaurante:          num('COMMISSION_RESTAURANTS', 12),  // 10-15% → default 12%
  tienda_conveniencia:  num('COMMISSION_STORES',      10),  // 8-12%  → default 10%
  farmacia:             num('COMMISSION_PHARMACY',     8),  // 5-10%  → default 8%
  licoreria:            num('COMMISSION_LIQUOR',      12),  // 10-15% → default 12%
  papeleria:            num('COMMISSION_PAPELERIA',    8),
  panaderia:            num('COMMISSION_PANADERIA',   10),
  'ahivoy store':       num('COMMISSION_AHIVOY',      10),
  distribuidora:        num('COMMISSION_DISTRIBUIDORA', 8),
  otro:                 num('COMMISSION_OTRO',        10),
};

// ─── 4. Zonas ──────────────────────────────────────────────
const ZONAS = {
  A: { desde: 0, hasta: 2,  fee: TARIFAS_CLIENTE.ZONA_A_FEE },
  B: { desde: 2, hasta: 5,  fee: TARIFAS_CLIENTE.ZONA_B_FEE },
  C: { desde: 5, hasta: 10, fee: TARIFAS_CLIENTE.ZONA_C_FEE },
};

// ─── 5. Distancia máxima ───────────────────────────────────
const MAX_DISTANCE_KM = num('MAX_DISTANCE_KM', 10);

// ─── 6. Bonos al repartidor (fase 2, pero ya dejamos definido) ───
const BONOS = {
  RAIN:      num('BONUS_RAIN',  5),    // bono por lluvia
  PEAK:      num('BONUS_PEAK',  5),    // bono por hora pico
  METAS_10:  num('BONUS_METAS_10', 20), // bono al completar 10 pedidos en el día
};

// ─── 7. Promociones al cliente (fase 2) ───────────────────
const PROMOS = {
  PRIMER_PEDIDO_GRATIS:  true,
  SUSCRIPCION_MENSUAL_MXN: num('SUSCRIPCION_MENSUAL_MXN', 99),
};

module.exports = {
  TARIFAS_CLIENTE,
  HORA_PICO_RANGOS,
  PAGO_REPARTIDOR,
  COMISIONES,
  ZONAS,
  MAX_DISTANCE_KM,
  BONOS,
  PROMOS,
};
