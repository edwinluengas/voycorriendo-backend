const ConfigZona = require('../models/ConfigZona');
const ConfigComision = require('../models/ConfigComision');
const PromoConfig = require('../models/PromoConfig');
const { COMISION_FLAT, PAGO_REPARTIDOR, TARIFAS_CLIENTE } = require('../config/precios');

const CACHE_TTL_MS = 5 * 60 * 1000;

let _zonas = null;
let _comisiones = null;
let _promos = null;
let _lastFetch = 0;

const isStale = () => Date.now() - _lastFetch > CACHE_TTL_MS;

const recargar = async () => {
  [_zonas, _comisiones, _promos] = await Promise.all([
    ConfigZona.findAll({ where: { activo: true } }),
    ConfigComision.findAll(),
    PromoConfig.findAll({ where: { activo: true } }),
  ]);
  _lastFetch = Date.now();
};

const getConfig = async () => {
  if (!_zonas || isStale()) await recargar();
  return { zonas: _zonas, comisiones: _comisiones, promos: _promos };
};

const getZona = async (tipoEnvio) => {
  const { zonas } = await getConfig();
  return zonas.find((z) => z.tipo_envio === tipoEnvio) || null;
};

const promoEfectivoActiva = (promos) => {
  const promo = promos.find((p) => p.clave === 'promo_efectivo_sin_comision');
  if (!promo) return false;
  const ahora = new Date();
  if (promo.fecha_fin && new Date(promo.fecha_fin) < ahora) return false;
  return true;
};

const getComision = async (metodo_pago, tipoEnvio) => {
  const { comisiones, promos } = await getConfig();

  const fila = comisiones.find(
    (c) => c.metodo_pago === metodo_pago && c.tipo_envio === tipoEnvio,
  ) || comisiones.find(
    (c) => c.metodo_pago === 'digital' && c.tipo_envio === tipoEnvio,
  );

  // Fallback: el modelo flat vigente ($35 de comisión al restaurante, el
  // repartidor se queda con el 100% del envío). El fallback viejo (5/30 y
  // 10/50) es de un modelo que ya no existe y fue la causa REAL de que un
  // repartidor cobrara $30 en vez de $35 cuando config_comisiones quedó
  // vacía (2026-07-22) — se alinea a config/precios.js para que un fallo de
  // DB nunca vuelva a cambiar los montos que ve la gente.
  const base = fila
    ? { comision_plataforma: Number(fila.comision_plataforma), pago_repartidor: Number(fila.pago_repartidor) }
    : {
        comision_plataforma: COMISION_FLAT,
        pago_repartidor: tipoEnvio === 'express' ? PAGO_REPARTIDOR.EXPRESS : PAGO_REPARTIDOR.STANDARD,
      };

  // Promo efectivo: driver se queda con la tarifa completa, plataforma cobra $0
  if (metodo_pago === 'efectivo' && promoEfectivoActiva(promos)) {
    const feeBase = tipoEnvio === 'express' ? TARIFAS_CLIENTE.EXPRESS : TARIFAS_CLIENTE.STANDARD;
    return { comision_plataforma: 0, pago_repartidor: feeBase };
  }

  return base;
};

const invalidarCache = () => { _lastFetch = 0; };

module.exports = { getZona, getComision, invalidarCache };
