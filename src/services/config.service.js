const ConfigZona = require('../models/ConfigZona');
const ConfigComision = require('../models/ConfigComision');
const PromoConfig = require('../models/PromoConfig');

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

  const base = fila
    ? { comision_plataforma: Number(fila.comision_plataforma), pago_repartidor: Number(fila.pago_repartidor) }
    : { comision_plataforma: tipoEnvio === 'express' ? 10 : 5, pago_repartidor: tipoEnvio === 'express' ? 50 : 30 };

  // Promo efectivo: driver se queda con la tarifa completa, plataforma cobra $0
  if (metodo_pago === 'efectivo' && promoEfectivoActiva(promos)) {
    const feeBase = tipoEnvio === 'express' ? 60 : 35;
    return { comision_plataforma: 0, pago_repartidor: feeBase };
  }

  return base;
};

const invalidarCache = () => { _lastFetch = 0; };

module.exports = { getZona, getComision, invalidarCache };
