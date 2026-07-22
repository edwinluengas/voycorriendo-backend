/**
 * Bloqueo permanente de repartidores/negocios que incumplen reglas —
 * placas y direcciones vetadas quedan en lista negra para siempre,
 * incluso si se intenta dar de alta en una cuenta nueva.
 *
 * IMPORTANTE: toda la lógica de validación de placa/dirección vive AQUÍ,
 * centralizada — cualquier endpoint que cree o actualice una placa o
 * dirección DEBE llamar a `validarPlacaRepartidor`/`validarDireccionNegocio`
 * antes de guardar. Repetir el chequeo a mano en cada controller es como
 * se coló el bug real de "endpoints legacy sin candado" (auditoría
 * 2026-07-21) — no lo repitas.
 */
const { Op } = require('sequelize');

const ESTADOS_NO_TERMINALES = ['pendiente', 'confirmado', 'preparando', 'listo', 'en_camino', 'en_envio'];

// Alerta a admin de inmediato si la cuenta que se bloquea tiene pedidos en
// curso — sin esto quedaban huérfanos hasta que un job de timeout los
// detectara (hasta 90 min después, o nunca para negocio en confirmado/
// preparando). No cancela ni reasigna solo: requiere intervención humana,
// mismo patrón que pedidoTimeout.job.alertarPedidosAtascados.
const alertarPedidosEnCursoPorBloqueo = async ({ Pedido }, where, entidad, motivo) => {
  const tg = require('./telegram.service');
  const pedidos = await Pedido.findAll({
    where: { ...where, estado: { [Op.in]: ESTADOS_NO_TERMINALES } },
    attributes: ['id', 'numero', 'estado'],
  });
  if (pedidos.length === 0) return;
  const lista = pedidos.map((p) => `#${p.numero} (${p.estado})`).join(', ');
  tg.enviarAdmin(
    `🚨 <b>${entidad} bloqueado con pedidos en curso</b>\n\n` +
    `Motivo: ${motivo}\n` +
    `Pedidos afectados: <b>${lista}</b>\n\n` +
    `Requieren reasignación o seguimiento manual — no se cancelaron ni reasignaron solos.`
  ).catch(() => {});
};

const normalizar = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
// Las placas se comparan ignorando espacios/guiones — "AB-123" y "AB 123"
// son la misma placa. El valor que se GUARDA en el registro es el que
// escribió el usuario (para mostrarlo tal cual); solo la comparación usa
// esta forma "pelada".
const normalizarPlaca = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ─── Repartidor: placa de vehículo ─────────────────────────────
const placaBloqueadaPermanente = async (placa) => {
  const { BloqueoPermanente } = require('../models');
  const valor = normalizarPlaca(placa);
  if (!valor) return null;
  return BloqueoPermanente.findOne({ where: { tipo: 'placa_repartidor', valor } });
};

// Valida una placa candidata contra la lista negra Y contra duplicados
// activos en otras cuentas. NO guarda nada — solo responde si es válida.
// Úsalo en CUALQUIER endpoint que reciba `placa_vehiculo` antes de guardar.
const validarPlacaRepartidor = async (repartidorId, placaCandidata) => {
  const { Repartidor } = require('../models');
  const valorPelado = normalizarPlaca(placaCandidata);
  if (!valorPelado) return { ok: true };

  const vetada = await placaBloqueadaPermanente(placaCandidata);
  if (vetada) {
    return { ok: false, permanente: true, motivo: vetada.motivo, valorPelado };
  }

  // Sin índice UNIQUE en DB para esta comparación "pelada" (no distingue
  // guiones/espacios), se compara en memoria — el volumen de repartidores
  // con placa asignada es bajo, este endpoint no es de alto tráfico.
  const candidatos = await Repartidor.findAll({
    where: {
      id: repartidorId ? { [Op.ne]: repartidorId } : { [Op.ne]: null },
      placa_vehiculo: { [Op.not]: null },
    },
    attributes: ['id', 'placa_vehiculo'],
  });
  const duplicado = candidatos.find((r) => normalizarPlaca(r.placa_vehiculo) === valorPelado);
  if (duplicado) {
    return { ok: false, permanente: false, motivo: `Placa ya registrada en otra cuenta (id ${duplicado.id})`, valorPelado };
  }
  return { ok: true };
};

// Bloquea la cuenta AHORA (estado_cuenta) y veta la placa para siempre.
const bloquearRepartidorPermanente = async (repartidor, motivo) => {
  const models = require('../models');
  const { BloqueoPermanente, Pedido } = models;
  repartidor.estado_cuenta   = 'bloqueado';
  repartidor.estado_motivo   = motivo;
  repartidor.baja_permanente = true;
  // No debe seguir recibiendo pedidos nuevos ni figurar como disponible,
  // sin importar por cuál de los 4 caminos se llegó a este bloqueo.
  repartidor.conectado       = false;
  repartidor.disponible      = false;
  await repartidor.save();

  const valor = normalizarPlaca(repartidor.placa_vehiculo);
  if (valor) {
    await BloqueoPermanente.findOrCreate({
      where: { tipo: 'placa_repartidor', valor },
      defaults: { motivo, entidad_id_origen: repartidor.id },
    });
  }

  await alertarPedidosEnCursoPorBloqueo({ Pedido }, { repartidor_id: repartidor.id }, `Repartidor ${repartidor.id}`, motivo);
};

// Levanta el veto permanente que ESTA cuenta generó sobre su propia placa
// (si lo hay) — usarlo cuando un admin revierte manualmente un bloqueo, para
// que la cuenta no se vuelva a auto-atrapar la próxima vez que toque su
// perfil. NO borra vetos originados por OTRA cuenta (esos requieren
// revisión aparte — ver DELETE /api/admin/bloqueos-permanentes/:id).
const liberarPlacaPropia = async (repartidor) => {
  const { BloqueoPermanente } = require('../models');
  const valor = normalizarPlaca(repartidor.placa_vehiculo);
  if (!valor) return;
  await BloqueoPermanente.destroy({
    where: { tipo: 'placa_repartidor', valor, entidad_id_origen: repartidor.id },
  });
};

// ─── Negocio: dirección ─────────────────────────────────────────
// JSON.stringify escapa correctamente cualquier "|" o comilla que el
// usuario haya escrito en la dirección — evita que alguien arme a propósito
// una dirección+colonia que colisione (o evada) la clave de otro negocio.
const claveDireccion = (direccion, colonia) => normalizar(JSON.stringify([direccion || '', colonia || '']));
const CLAVE_DIRECCION_VACIA = claveDireccion('', '');

const direccionBloqueadaPermanente = async (direccion, colonia) => {
  const { BloqueoPermanente } = require('../models');
  const valor = claveDireccion(direccion, colonia);
  if (!valor || valor === CLAVE_DIRECCION_VACIA) return null;
  return BloqueoPermanente.findOne({ where: { tipo: 'direccion_negocio', valor } });
};

// Mismo patrón que validarPlacaRepartidor pero para dirección de negocio.
const validarDireccionNegocio = async (negocioId, direccionCandidata, coloniaCandidata) => {
  const { Negocio } = require('../models');
  const clave = claveDireccion(direccionCandidata, coloniaCandidata);
  if (!clave || clave === CLAVE_DIRECCION_VACIA) return { ok: true };

  const vetada = await direccionBloqueadaPermanente(direccionCandidata, coloniaCandidata);
  if (vetada) {
    return { ok: false, permanente: true, motivo: vetada.motivo };
  }

  const otros = await Negocio.findAll({
    where: {
      id: negocioId ? { [Op.ne]: negocioId } : { [Op.ne]: null },
      direccion: { [Op.not]: null },
    },
    attributes: ['id', 'direccion', 'colonia'],
  });
  const duplicado = otros.find((n) => claveDireccion(n.direccion, n.colonia) === clave);
  if (duplicado) {
    return { ok: false, permanente: false, motivo: `Dirección ya registrada en otra cuenta (id ${duplicado.id})` };
  }
  return { ok: true };
};

const bloquearNegocioPermanente = async (negocio, motivo) => {
  const models = require('../models');
  const { BloqueoPermanente, Pedido } = models;
  negocio.estado_cuenta = 'bloqueado';
  negocio.estado_motivo = motivo;
  // Un negocio bloqueado no debe seguir operable — activo=true lo dejaba
  // aceptar pedidos vía deep link/historial/favoritos aunque ya no
  // apareciera en el listado público.
  negocio.activo        = false;
  negocio.abierto_ahora  = false;
  await negocio.save();

  const valor = claveDireccion(negocio.direccion, negocio.colonia);
  if (valor && valor !== CLAVE_DIRECCION_VACIA) {
    await BloqueoPermanente.findOrCreate({
      where: { tipo: 'direccion_negocio', valor },
      defaults: { motivo, entidad_id_origen: negocio.id },
    });
  }

  await alertarPedidosEnCursoPorBloqueo({ Pedido }, { negocio_id: negocio.id }, `Negocio ${negocio.id}`, motivo);
};

// Igual que liberarPlacaPropia pero para dirección de negocio.
const liberarDireccionPropia = async (negocio) => {
  const { BloqueoPermanente } = require('../models');
  const valor = claveDireccion(negocio.direccion, negocio.colonia);
  if (!valor || valor === CLAVE_DIRECCION_VACIA) return;
  await BloqueoPermanente.destroy({
    where: { tipo: 'direccion_negocio', valor, entidad_id_origen: negocio.id },
  });
};

module.exports = {
  normalizar,
  normalizarPlaca,
  placaBloqueadaPermanente,
  validarPlacaRepartidor,
  bloquearRepartidorPermanente,
  liberarPlacaPropia,
  claveDireccion,
  direccionBloqueadaPermanente,
  validarDireccionNegocio,
  bloquearNegocioPermanente,
  liberarDireccionPropia,
};
