/**
 * Envío de email transaccional — VoyCorriendo
 * ------------------------------------------------------------------
 * Soporta dos proveedores, en este orden de preferencia:
 *   1. Resend  → RESEND_API_KEY (HTTP, sin dependencias nuevas)
 *   2. SMTP    → SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS (Gmail incluido;
 *                requiere el paquete `nodemailer`, que es opcional)
 *
 * Si NINGUNO está configurado, `enviarEmail` devuelve
 * { ok:false, motivo:'no_configurado' } en vez de lanzar — así el flujo de
 * recuperación de contraseña sigue funcionando por SMS y le puede decir al
 * usuario, con honestidad, que el correo no está disponible todavía.
 */
const axios = require('axios');

const REMITENTE = process.env.EMAIL_FROM || 'VoyCorriendo <voycorriendoadmin@gmail.com>';

const hayResend = () => !!process.env.RESEND_API_KEY;
const haySMTP   = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const emailConfigurado = () => hayResend() || haySMTP();

const enviarPorResend = async ({ para, asunto, html, texto }) => {
  await axios.post(
    'https://api.resend.com/emails',
    { from: REMITENTE, to: [para], subject: asunto, html, text: texto },
    { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 10000 },
  );
  return { ok: true, proveedor: 'resend' };
};

const enviarPorSMTP = async ({ para, asunto, html, texto }) => {
  // require diferido: nodemailer es opcional, no queremos romper el arranque
  // del servidor si no está instalado y nadie usa SMTP.
  const nodemailer = require('nodemailer');
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporte.sendMail({ from: REMITENTE, to: para, subject: asunto, html, text: texto });
  return { ok: true, proveedor: 'smtp' };
};

const enviarEmail = async ({ para, asunto, html, texto }) => {
  if (!para) return { ok: false, motivo: 'sin_destinatario' };
  if (!emailConfigurado()) return { ok: false, motivo: 'no_configurado' };
  try {
    return hayResend()
      ? await enviarPorResend({ para, asunto, html, texto })
      : await enviarPorSMTP({ para, asunto, html, texto });
  } catch (e) {
    // El detalle del proveedor (Resend/SMTP) sirve para diagnosticar en logs;
    // al usuario final nunca se le muestra crudo.
    const detalle = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('[email] Falló el envío:', detalle);
    return { ok: false, motivo: 'error_envio', detalle };
  }
};

// Plantilla del código de recuperación de contraseña
const emailCodigoReset = (codigo, nombre) => ({
  asunto: `Tu código para recuperar tu contraseña: ${codigo}`,
  texto: `Hola ${nombre || ''}, tu código para restablecer tu contraseña de VoyCorriendo es ${codigo}. `
       + `Vence en 15 minutos. Si no lo pediste, ignora este correo.`,
  html: `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#FF5C00;margin:0 0 8px">VoyCorriendo</h2>
      <p style="font-size:15px;color:#111827">Hola ${nombre || ''}, usa este código para restablecer tu contraseña:</p>
      <div style="font-size:38px;font-weight:800;letter-spacing:8px;color:#111827;background:#F8F9FA;
                  border:1px solid #E5E7EB;border-radius:12px;padding:18px;text-align:center;margin:16px 0">
        ${codigo}
      </div>
      <p style="font-size:13px;color:#6B7280">Vence en 15 minutos y solo se puede usar una vez.
      Si tú no pediste este cambio, ignora este correo: tu contraseña actual sigue funcionando.</p>
    </div>`,
});

module.exports = { enviarEmail, emailConfigurado, emailCodigoReset };
