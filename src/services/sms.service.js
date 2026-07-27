/**
 * Envío de SMS — VoyCorriendo
 * ------------------------------------------------------------------
 * Centraliza Twilio para que TODO el sistema mande al mismo formato E.164
 * usando la lada real de la cuenta (Puerto Escondido tiene clientes
 * extranjeros; asumir +52 mandaba los códigos a un número que no existe).
 *
 * Lanza si no está configurado o si Twilio rechaza — quien llama decide si
 * eso es fatal (segundo factor de admin) o solo un aviso (OTP informativo).
 */
const twilio = require('twilio');
const { aE164, LADA_DEFAULT } = require('../utils/telefono');

const cliente = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const smsConfigurado = () => !!cliente;

// destino: { telefono, lada } — acepta también un objeto Usuario.
const enviarSMSSeguro = async (destino, mensaje) => {
  if (!cliente) throw new Error('SMS no configurado en el servidor.');
  const telefono = destino?.telefono;
  const lada = destino?.lada || LADA_DEFAULT;
  if (!telefono) throw new Error('La cuenta no tiene teléfono.');
  await cliente.messages.create({
    body: mensaje,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: aE164({ lada, telefono }),
  });
  return true;
};

module.exports = { enviarSMSSeguro, smsConfigurado };
