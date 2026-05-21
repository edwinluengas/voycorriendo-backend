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
const { enviar } = require('../services/telegram.service');

const manejarUpdate = async (req, res) => {
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
