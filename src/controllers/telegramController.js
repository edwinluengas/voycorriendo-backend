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

      usuario.telegram_chat_id = chatId;
      await usuario.save();

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
    if (!admin || (admin.rol !== 'admin' && admin.modo_activo !== 'admin')) {
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
