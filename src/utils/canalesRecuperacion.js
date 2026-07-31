/**
 * Canales que pueden entregar HOY un código de recuperación de contraseña.
 *
 * Fuente ÚNICA, a propósito: la usan `/api/config-publica` (para que la app
 * solo ofrezca opciones que funcionan) y `authController` (para que ningún
 * mensaje de error mande al usuario a un canal apagado). Cuando esta lógica
 * vivía duplicada en los dos lados, la pantalla decía una cosa y el error
 * del servidor otra — "recibe tu código por SMS" con Twilio en trial.
 */
const { smsConfigurado } = require('../services/sms.service');
const { emailConfigurado } = require('../services/email.service');

const ETIQUETA_CANAL = { sms: 'por SMS', email: 'por correo', telegram: 'por Telegram' };

// Telegram no depende de que el servidor tenga un proveedor contratado sino
// de que cada usuario lo tenga vinculado, así que siempre se puede ofrecer.
const canalesActivos = () => [
  smsConfigurado() && 'sms',
  emailConfigurado() && 'email',
  'telegram',
].filter(Boolean);

// Arma la frase de "prueba con este otro" nombrando SOLO canales vivos.
// Ej: sugerirOtros('email') → "Recibe tu código por Telegram."
const sugerirOtros = (excepto) => {
  const otros = canalesActivos()
    .filter((c) => c !== excepto)
    .map((c) => ETIQUETA_CANAL[c]);
  if (!otros.length) return 'Escríbenos a soporte para recuperar tu cuenta.';
  return `Recibe tu código ${otros.join(' o ')}.`;
};

module.exports = { canalesActivos, sugerirOtros, ETIQUETA_CANAL };
