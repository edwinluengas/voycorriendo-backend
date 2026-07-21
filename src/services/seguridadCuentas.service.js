/**
 * Bloqueo permanente de repartidores/negocios que incumplen reglas —
 * placas y direcciones vetadas quedan en lista negra para siempre,
 * incluso si se intenta dar de alta en una cuenta nueva.
 */
const { BloqueoPermanente } = require('../models');

const normalizar = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');

// ─── Repartidor: placa de vehículo ─────────────────────────────
const placaBloqueadaPermanente = async (placa) => {
  const valor = normalizar(placa);
  if (!valor) return null;
  return BloqueoPermanente.findOne({ where: { tipo: 'placa_repartidor', valor } });
};

// Bloquea la cuenta AHORA (estado_cuenta) y veta la placa para siempre.
const bloquearRepartidorPermanente = async (repartidor, motivo) => {
  repartidor.estado_cuenta   = 'bloqueado';
  repartidor.estado_motivo   = motivo;
  repartidor.baja_permanente = true;
  await repartidor.save();

  const valor = normalizar(repartidor.placa_vehiculo);
  if (valor) {
    await BloqueoPermanente.findOrCreate({
      where: { tipo: 'placa_repartidor', valor },
      defaults: { motivo, entidad_id_origen: repartidor.id },
    });
  }
};

// ─── Negocio: dirección ─────────────────────────────────────────
const claveDireccion = (direccion, colonia) => normalizar(`${direccion || ''}|${colonia || ''}`);

const direccionBloqueadaPermanente = async (direccion, colonia) => {
  const valor = claveDireccion(direccion, colonia);
  if (!valor || valor === '|') return null;
  return BloqueoPermanente.findOne({ where: { tipo: 'direccion_negocio', valor } });
};

const bloquearNegocioPermanente = async (negocio, motivo) => {
  negocio.estado_cuenta = 'bloqueado';
  negocio.estado_motivo = motivo;
  await negocio.save();

  const valor = claveDireccion(negocio.direccion, negocio.colonia);
  if (valor && valor !== '|') {
    await BloqueoPermanente.findOrCreate({
      where: { tipo: 'direccion_negocio', valor },
      defaults: { motivo, entidad_id_origen: negocio.id },
    });
  }
};

module.exports = {
  normalizar,
  placaBloqueadaPermanente,
  bloquearRepartidorPermanente,
  claveDireccion,
  direccionBloqueadaPermanente,
  bloquearNegocioPermanente,
};
