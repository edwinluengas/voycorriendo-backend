/**
 * Webhook del bot de Telegram.
 *
 * Comandos soportados:
 *   /start {jwt}  — vincula la cuenta de la app con este chat de Telegram
 *   /estado       — muestra estado de la cuenta vinculada
 *   /desvincular  — elimina el telegram_chat_id del usuario
 */

const jwt = require('jsonwebtoken');
const { Usuario } = require('../models');
const { enviar, WEBHOOK_SECRET } = require('../services/telegram.service');

const manejarUpdate = async (req, res) => {
  // Validar que el request viene de Telegram via secret_token
  if (WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret !== WEBHOOK_SECRET) {
      return res.sendStatus(403);
    }
  }

  res.sendStatus(200); // Telegram necesita 200 inmediato

  const msg = req.body?.message;
  if (!msg?.text) return;

  const chatId  = msg.chat.id;
  const texto   = msg.text.trim();
  const nombre  = msg.from?.first_name || 'usuario';

  // /start {jwt_token}
  if (texto.startsWith('/start')) {
    const parts = texto.split(' ');
    const token = parts[1];

    if (!token) {
      return enviar(chatId,
        `👋 Hola <b>${nombre}</b>!\nPara vincular tu cuenta de VoyCorriendo, usa el botón <b>"Vincular Telegram"</b> desde la app.`
      );
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const usuario = await Usuario.findByPk(payload.id);

      if (!usuario) {
        return enviar(chatId, '❌ Token inválido. Genera un nuevo enlace desde la app.');
      }
      // El token debe estar VIGENTE. Sin esto, un JWT viejo o ya revocado
      // (logout, cambio de contraseña) seguía sirviendo para vincular un
      // chat — y en una cuenta admin ese chat recibe los códigos de segundo
      // factor y puede correr los comandos de administración del bot.
      if ((payload.tokenVersion ?? 0) !== (usuario.token_version ?? 0)) {
        return enviar(chatId, '❌ Ese enlace ya no es válido. Genera uno nuevo desde la app.');
      }

      const chatAnterior = usuario.telegram_chat_id;
      usuario.telegram_chat_id = chatId;
      await usuario.save();

      // Vincular el Telegram de una cuenta admin es un evento de seguridad:
      // ese chat pasa a recibir los códigos de acceso al panel.
      if (usuario.rol === 'admin') {
        const seguridad = require('../services/seguridadAdmin.service');
        await seguridad.registrarEvento({ usuario, accion: 'telegram_vinculado_admin', req: null, detalle: { chatId, chatAnterior } });
        if (chatAnterior && String(chatAnterior) !== String(chatId)) {
          await enviar(chatAnterior,
            '🚨 <b>Alerta de seguridad</b>\nEl Telegram de esta cuenta ADMIN se acaba de vincular a otro chat. '
            + 'Si no fuiste tú, cambia tu contraseña ahora y corre <code>admin-seguridad.js cerrar-sesiones</code>.'
          ).catch(() => {});
        }
      }

      return enviar(chatId,
        `✅ <b>Cuenta vinculada</b>\nHola ${usuario.nombre}, recibirás notificaciones de VoyCorriendo aquí.`
      );
    } catch (_) {
      return enviar(chatId, '❌ El enlace expiró. Genera uno nuevo desde la app.');
    }
  }

  // /estado
  if (texto === '/estado') {
    const usuario = await Usuario.findOne({ where: { telegram_chat_id: chatId } });
    if (!usuario) {
      return enviar(chatId, '🔗 No tienes ninguna cuenta vinculada. Usa /start {token} desde la app.');
    }
    return enviar(chatId,
      `👤 <b>${usuario.nombre} ${usuario.apellido}</b>\nRol: ${usuario.rol}\nEstado: ${usuario.estado}`
    );
  }

  // /desvincular
  if (texto === '/desvincular') {
    const usuario = await Usuario.findOne({ where: { telegram_chat_id: chatId } });
    if (!usuario) return enviar(chatId, 'No hay cuenta vinculada.');
    usuario.telegram_chat_id = null;
    await usuario.save();
    return enviar(chatId, '✅ Cuenta desvinculada. Ya no recibirás notificaciones.');
  }

  // ── Comandos de ADMIN: aclaraciones de pedidos perdidos ──────
  // Gate: el chat debe pertenecer a una cuenta vinculada con rol admin.
  // Mismo poder que los endpoints /api/admin/perdidas (la vinculación se
  // hace con JWT desde la app, y el secret_token del webhook ya validó que
  // el update viene de Telegram).
  if (texto.startsWith('/perdidas') || texto.startsWith('/perdida_')) {
    const admin = await Usuario.findOne({ where: { telegram_chat_id: chatId } });
    if (!admin || admin.rol !== 'admin') {   // rol REAL, no el toggle modo_activo
      return enviar(chatId, '⛔ Este comando es solo para administradores.');
    }
    const { PerdidaPedido, Pedido } = require('../models');
    const { reclasificarPerdida, eliminarPerdida } = require('../services/perdidas.service');

    const buscarPorNumero = async (numero) => {
      const pedido = await Pedido.findOne({ where: { numero: numero.toUpperCase() } });
      if (!pedido) return null;
      return PerdidaPedido.findOne({ where: { pedido_id: pedido.id } });
    };

    try {
      if (texto === '/perdidas') {
        const activas = await PerdidaPedido.findAll({ where: { estado: 'activa' }, order: [['creado_en', 'DESC']], limit: 15 });
        if (activas.length === 0) return enviar(chatId, '✅ Sin pérdidas activas.');
        const pedidos = await Pedido.findAll({ where: { id: activas.map((p) => p.pedido_id) }, attributes: ['id', 'numero'] });
        const num = Object.fromEntries(pedidos.map((p) => [p.id, p.numero]));
        return enviar(chatId,
          '📉 <b>Pérdidas activas</b>\n' + activas.map((p) =>
            `${num[p.pedido_id]} — $${parseFloat(p.monto).toFixed(2)} (${p.tipo}) · rest $${parseFloat(p.cargo_restaurante).toFixed(2)} / rep $${parseFloat(p.cargo_repartidor).toFixed(2)} / plat $${parseFloat(p.cargo_plataforma).toFixed(2)}`
          ).join('\n') +
          '\n\n/perdida_intencional MND-XXXXXX — 60% al repartidor\n/perdida_normal MND-XXXXXX — volver a 50/50\n/perdida_eliminar MND-XXXXXX — aclaración válida (revierte cargos)');
      }

      const [cmd, numero] = texto.split(/\s+/);
      if (!numero) return enviar(chatId, 'Falta el número de pedido. Ej: ' + cmd + ' MND-123456');
      const perdida = await buscarPorNumero(numero);
      if (!perdida) return enviar(chatId, `No encontré una pérdida registrada para ${numero}.`);

      if (cmd === '/perdida_intencional' || cmd === '/perdida_normal') {
        const tipo = cmd === '/perdida_intencional' ? 'intencional' : 'normal';
        await reclasificarPerdida(perdida, tipo);
        return enviar(chatId, `✅ ${numero} reclasificada a <b>${tipo}</b>. Cargos: restaurante $${parseFloat(perdida.cargo_restaurante).toFixed(2)} | repartidor $${parseFloat(perdida.cargo_repartidor).toFixed(2)} | plataforma $${parseFloat(perdida.cargo_plataforma).toFixed(2)}. Balances actualizados.`);
      }
      if (cmd === '/perdida_eliminar') {
        await eliminarPerdida(perdida, `Aclaración válida (admin ${admin.nombre} vía Telegram).`);
        return enviar(chatId, `✅ Pérdida de ${numero} eliminada — cargos revertidos y balances recalculados automáticamente.`);
      }
      return enviar(chatId, 'Comando de pérdidas no reconocido. Usa /perdidas para ver opciones.');
    } catch (e) {
      return enviar(chatId, `❌ Error: ${e.message}`);
    }
  }

  // ── Comando de ADMIN: otorgar crédito de plataforma a un cliente ────
  // Uso: /credito 5545074460 100 Pedido perdido, se compensa con credito
  // El motivo es obligatorio (queda en el historial del cliente) y puede
  // llevar varias palabras — todo lo que sigue al monto.
  // OJO: /^\/credito(\s|$)/ — NO usar startsWith('/credito'), porque
  // '/creditos' (el comando de resumen, abajo) también empieza con esas
  // 8 letras y quedaría atrapado aquí sin nunca llegar a su propio bloque.
  if (/^\/credito(\s|$)/.test(texto)) {
    const admin = await Usuario.findOne({ where: { telegram_chat_id: chatId } });
    if (!admin || admin.rol !== 'admin') {   // rol REAL, no el toggle modo_activo
      return enviar(chatId, '⛔ Este comando es solo para administradores.');
    }
    const partes = texto.split(/\s+/);
    const [, telefono, montoStr, ...restoMotivo] = partes;
    const monto = parseFloat(montoStr);
    const motivo = restoMotivo.join(' ').trim();
    if (!telefono || !Number.isFinite(monto) || monto <= 0 || !motivo) {
      return enviar(chatId, 'Uso: /credito {telefono} {monto} {motivo}\nEj: /credito 5545074460 100 Pedido perdido, se compensa con crédito');
    }
    try {
      // Con teléfonos internacionales el número nacional ya NO es único: dos
      // países pueden repetirlo. Se acepta "+1 954…" o "5545074460" (México
      // por defecto) y, si hay varias coincidencias, se piden explícitas en
      // vez de otorgarle el crédito a la primera cuenta que aparezca.
      const { normalizarTelefono } = require('../utils/telefono');
      const llevaLada = /^\+/.test(telefono);
      const { lada, telefono: nacional } = normalizarTelefono(
        telefono.replace(/^\+/, ''),
        llevaLada ? telefono.replace(/^\+/, '').slice(0, 2) : '52',
      );
      let cliente = await Usuario.findOne({ where: { telefono: nacional, lada } });
      if (!cliente) {
        const candidatos = await Usuario.findAll({ where: { telefono: nacional } });
        if (candidatos.length === 1) {
          cliente = candidatos[0];
        } else if (candidatos.length > 1) {
          return enviar(chatId, `Hay ${candidatos.length} cuentas con ese número en países distintos:\n`
            + candidatos.map((c) => `• +${c.lada} ${c.telefono} — ${c.nombre} ${c.apellido || ''}`).join('\n')
            + '\nRepite el comando con la lada, ej. /credito +52' + nacional + ' …');
        }
      }
      if (!cliente) return enviar(chatId, `No encontré ninguna cuenta con el teléfono ${telefono}.`);
      const { otorgarCredito } = require('../services/creditos.service');
      const resultado = await otorgarCredito({ usuarioId: cliente.id, monto, motivo, adminId: admin.id });
      return enviar(chatId, `✅ $${monto.toFixed(2)} de crédito otorgados a ${cliente.nombre} (***${telefono.slice(-4)}).\nSaldo nuevo: $${resultado.credito_disponible.toFixed(2)}.\nMotivo: ${motivo}`);
    } catch (e) {
      return enviar(chatId, `❌ Error: ${e.message}`);
    }
  }

  // ── Comando de ADMIN: resumen de la "cuenta por pagar" del crédito ──
  // Cuánto se ha otorgado, cuánto sigue como saldo con clientes, y cuánto
  // ya se le pagó de verdad a negocios/repartidores con fondos propios de
  // la plataforma (pedidos entregados pagados con crédito).
  if (texto === '/creditos') {
    const admin = await Usuario.findOne({ where: { telegram_chat_id: chatId } });
    if (!admin || admin.rol !== 'admin') {   // rol REAL, no el toggle modo_activo
      return enviar(chatId, '⛔ Este comando es solo para administradores.');
    }
    try {
      const { sequelize } = require('../config/database');
      const [[otorgado]] = await sequelize.query(`SELECT COALESCE(SUM(monto),0) AS t FROM creditos_cliente`);
      const [[disponible]] = await sequelize.query(`SELECT COALESCE(SUM(credito_disponible),0) AS t FROM usuarios WHERE credito_disponible > 0`);
      const [[pagado]] = await sequelize.query(`SELECT COALESCE(SUM(credito_aplicado),0) AS t FROM ledger_conciliacion WHERE credito_aplicado > 0`);
      return enviar(chatId,
        `📒 <b>Resumen de crédito de plataforma</b>\n\n` +
        `Otorgado histórico: $${parseFloat(otorgado.t).toFixed(2)}\n` +
        `Pasivo actual con clientes (sin usar): $${parseFloat(disponible.t).toFixed(2)}\n` +
        `Pagado a negocios/repartidores con fondos propios (pedidos entregados): $${parseFloat(pagado.t).toFixed(2)}`
      );
    } catch (e) {
      return enviar(chatId, `❌ Error: ${e.message}`);
    }
  }

  // Comando desconocido
  enviar(chatId, 'Comandos disponibles:\n/estado — Ver cuenta vinculada\n/desvincular — Dejar de recibir alertas');
};

// GET /api/telegram/vincular-link — genera JWT de 10 min para el deep link
const generarLinkVinculacion = async (req, res) => {
  const token = jwt.sign({ id: req.usuario.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'VoyCorriendoBot';
  const deepLink = `https://t.me/${botUsername}?start=${token}`;
  res.json({ ok: true, data: { link: deepLink } });
};

module.exports = { manejarUpdate, generarLinkVinculacion };
