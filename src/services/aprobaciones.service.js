/**
 * Aprobar y rechazar perfiles de repartidor y negocio — punto ÚNICO.
 *
 * Lo usan los dos caminos que existen: el panel de admin de la app y los
 * comandos del bot de Telegram. Está centralizado a propósito: cuando la
 * aprobación vivía suelta en el controlador, agregar un canal nuevo (el bot)
 * significaba duplicar la lógica, y el día que se olvide una notificación
 * en una de las copias nadie se entera — el repartidor simplemente nunca
 * sabe que ya puede trabajar.
 *
 * Al aprobar se avisa por TRES vías, y ninguna puede tumbar la operación:
 *   1. Correo a la persona (el canal que siempre llega).
 *   2. Telegram a la persona, si tiene su cuenta vinculada.
 *   3. Telegram al admin, como acuse de que la acción quedó hecha.
 * Si una falla se registra y se sigue: el perfil YA quedó aprobado en la
 * base, y hacer fallar la petición por un correo caído sería peor.
 */
const { Usuario, Repartidor, Negocio } = require('../models');
const { enviarEmail, emailPerfilAprobado } = require('./email.service');
const { logAdmin } = require('../utils/audit');
const { plazaDe, nombreDe } = require('../config/ciudades');
const tg = require('./telegram.service');

// ─── Notificaciones (nunca lanzan) ────────────────────────
const notificarAprobado = async ({ usuario, tipo, nombreEntidad, adminId, origen }) => {
  const resultado = { email: false, telegramUsuario: false, telegramAdmin: false };

  if (usuario?.email) {
    const plantilla = emailPerfilAprobado(usuario.nombre, tipo);
    const r = await enviarEmail({ para: usuario.email, ...plantilla });
    resultado.email = r.ok;
    if (!r.ok) console.warn(`[aprobaciones] No se pudo mandar el correo a ${usuario.email}: ${r.motivo}`);
  }

  if (usuario?.telegram_chat_id) {
    try {
      await tg.alertaAprobado(usuario.telegram_chat_id, tipo);
      resultado.telegramUsuario = true;
    } catch (e) { console.warn('[aprobaciones] Telegram al usuario falló:', e.message); }
  }

  try {
    const quien = `${usuario?.nombre || ''} ${usuario?.apellido || ''}`.trim() || 'sin nombre';
    await tg.enviarAdmin(
      `✅ <b>Perfil aprobado</b>\n\n`
      + `${tipo === 'repartidor' ? '🛵 Repartidor' : '🏪 Negocio'}: <b>${nombreEntidad || quien}</b>\n`
      + `Cuenta: +${usuario?.lada || '52'} ${usuario?.telefono || '—'}\n`
      + `Aprobado desde: ${origen}\n\n`
      + `Avisos enviados → correo: ${resultado.email ? 'sí' : 'no'} · `
      + `Telegram al usuario: ${resultado.telegramUsuario ? 'sí' : 'no vinculado'}`,
    );
    resultado.telegramAdmin = true;
  } catch (e) { console.warn('[aprobaciones] Telegram al admin falló:', e.message); }

  return resultado;
};

// ─── Aprobar ──────────────────────────────────────────────
const aprobarRepartidor = async (repartidor, { adminId, origen = 'panel' } = {}) => {
  const antes = { verificacion_estado: repartidor.verificacion_estado };
  await repartidor.update({
    verificacion_estado: 'aprobado',
    verificacion_nota: null,
    antecedentes_ok: true,
    resolucion_en: new Date(),
  });

  const usuario = await Usuario.findByPk(repartidor.usuario_id);
  const avisos = await notificarAprobado({ usuario, tipo: 'repartidor', adminId, origen });
  logAdmin({
    adminId, accion: 'aprobar_repartidor', entidadTipo: 'repartidor', entidadId: repartidor.id,
    estadoAntes: antes, estadoDespues: { verificacion_estado: 'aprobado', origen, avisos },
  });
  return { repartidor, usuario, avisos };
};

const aprobarNegocio = async (negocio, { adminId, origen = 'panel' } = {}) => {
  const antes = { verificacion_estado: negocio.verificacion_estado };

  // Última red: la plaza se fija desde el GPS en el momento de aprobar, venga
  // el negocio del wizard, del endpoint legacy o de una carga manual. Un
  // negocio aprobado en la plaza equivocada sale en el catálogo de un pueblo
  // al que ningún repartidor suyo puede llegar, y desaparece del propio.
  const plaza = plazaDe(negocio.latitud, negocio.longitud);
  if (!plaza.dentro) {
    const e = new Error(
      `No se puede aprobar: la ubicación del negocio queda fuera de nuestras plazas`
      + `${plaza.km != null ? ` (a ${Math.round(plaza.km)} km de ${nombreDe(plaza.slug)})` : ' (sin coordenadas válidas)'}.`,
    );
    e.codigo = 'FUERA_DE_PLAZA';
    throw e;
  }

  await negocio.update({
    verificacion_estado: 'aprobado',
    verificacion_nota: null,
    activo: true,
    ciudad: plaza.slug,
    resolucion_en: new Date(),
  });

  const usuario = await Usuario.findByPk(negocio.usuario_id);
  const avisos = await notificarAprobado({ usuario, tipo: 'negocio', nombreEntidad: negocio.nombre, adminId, origen });
  logAdmin({
    adminId, accion: 'aprobar_negocio', entidadTipo: 'negocio', entidadId: negocio.id,
    estadoAntes: antes, estadoDespues: { verificacion_estado: 'aprobado', origen, avisos },
  });
  return { negocio, usuario, avisos };
};

// ─── Pendientes (para el panel y para /pendientes del bot) ─
const listarPendientes = async () => {
  const estados = ['pendiente', 'en_revision'];
  const [repartidores, negocios] = await Promise.all([
    Repartidor.findAll({
      where: { verificacion_estado: estados },
      include: [{ model: Usuario, as: 'usuario', attributes: ['nombre', 'apellido', 'telefono', 'lada', 'email'] }],
      order: [['enviado_revision_en', 'ASC NULLS LAST']],
    }),
    Negocio.findAll({
      where: { verificacion_estado: estados },
      include: [{ model: Usuario, as: 'dueno', attributes: ['nombre', 'apellido', 'telefono', 'lada', 'email'] }],
      order: [['enviado_revision_en', 'ASC NULLS LAST']],
    }),
  ]);
  return { repartidores, negocios };
};

module.exports = { aprobarRepartidor, aprobarNegocio, listarPendientes, notificarAprobado };
