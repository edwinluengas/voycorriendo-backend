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

// SMS APAGADO (2026-07-31, decisión del dueño): Twilio sigue en cuenta de
// prueba y solo entrega a números verificados por él, así que a un cliente
// real nunca le llegaba nada — ofrecerlo era prometer algo que no pasaba.
// Nada se borra: las credenciales siguen ahí y basta poner SMS_ACTIVO=true
// para reactivarlo cuando la cuenta salga de trial.
// Se lee en CADA consulta, no al cargar el módulo. Como constante, cambiar
// la variable en Railway no surtía efecto hasta reiniciar el proceso — y
// eso ya nos mordió: el puente de correo siguió redirigiendo a un buzón
// personal después de darlo por apagado. Un interruptor que promete
// 'se cambia sin desplegar' tiene que cumplirlo.
const smsActivo = () => String(process.env.SMS_ACTIVO || 'false').toLowerCase() === 'true';

const smsConfigurado = () => smsActivo() && !!cliente;

// destino: { telefono, lada } — acepta también un objeto Usuario.
const enviarSMSSeguro = async (destino, mensaje) => {
  if (!smsActivo()) throw new Error('El envío de SMS está desactivado en el servidor.');
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
