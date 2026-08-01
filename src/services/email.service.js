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

// Resend SOLO deja enviar desde un dominio verificado por ti o desde su
// remitente de pruebas. Un `from` en gmail/hotmail/outlook lo rechaza con
// 403 "domain is not verified", y el correo nunca sale — con el agravante
// de que el error se ve igual que cualquier otro fallo de envío.
const DOMINIOS_AJENOS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'live.com', 'icloud.com'];
const REMITENTE_PRUEBAS = 'VoyCorriendo <onboarding@resend.dev>';

const remitenteParaResend = () => {
  const dominio = (REMITENTE.match(/@([^>\s]+)/) || [])[1]?.toLowerCase();
  if (dominio && DOMINIOS_AJENOS.includes(dominio)) {
    if (!remitenteParaResend._avisado) {
      console.warn(
        `[email] EMAIL_FROM usa @${dominio}, que Resend no deja usar como remitente `
        + `(solo dominios verificados). Se envía desde ${REMITENTE_PRUEBAS} — ojo: sin `
        + `dominio propio verificado, Resend SOLO entrega al correo dueño de la cuenta.`,
      );
      remitenteParaResend._avisado = true;
    }
    return REMITENTE_PRUEBAS;
  }
  return REMITENTE;
};

const enviarPorResend = async ({ para, asunto, html, texto }) => {
  try {
    await axios.post(
      'https://api.resend.com/emails',
      { from: remitenteParaResend(), to: [para], subject: asunto, html, text: texto },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 10000 },
    );
    return { ok: true, proveedor: 'resend' };
  } catch (e) {
    // El mensaje de Resend dice exactamente qué está mal (dominio sin
    // verificar, clave inválida, destinatario no permitido en modo prueba).
    // Sin esto en el log, diagnosticar por qué no llega un correo es a ciegas.
    const detalle = e.response?.data?.message || e.response?.data?.error || e.message;
    console.error(`[email] Resend rechazó el envío (${e.response?.status || 'sin status'}): ${detalle}`);
    throw e;
  }
};

const enviarPorSMTP = async ({ para, asunto, html, texto }) => {
  // require diferido: nodemailer es opcional, no queremos romper el arranque
  // del servidor si no está instalado y nadie usa SMTP.
  const nodemailer = require('nodemailer');
  // TIMEOUTS OBLIGATORIOS. Sin ellos, un SMTP que no contesta deja la
  // petición colgada hasta que el proxy la corta — se midió en producción:
  // 121 segundos y un 502. La app corta a los 15 s y muestra "revisa tu
  // internet", así que el usuario cree que el problema es suyo cuando en
  // realidad el servidor está esperando a Gmail.
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 8000,   // abrir la conexión
    greetingTimeout:   8000,   // que el servidor salude
    socketTimeout:     10000,  // inactividad durante el envío
  });
  await transporte.sendMail({ from: REMITENTE, to: para, subject: asunto, html, text: texto });
  return { ok: true, proveedor: 'smtp' };
};

// PUENTE TEMPORAL mientras no hay dominio verificado en Resend.
//
// Sin dominio propio, Resend SOLO entrega al correo dueño de la cuenta, así
// que un correo dirigido a un cliente simplemente no sale. Con
// EMAIL_REDIRIGIR_A definido, todo se manda a ese buzón con el destinatario
// real en grande arriba, para poder reenviarlo a mano y que nadie se quede
// sin su código.
//
// Se apaga borrando la variable — hacerlo depender de una variable explícita
// y no de "detectar si hay dominio" es a propósito: el día que se verifique
// el dominio, esto tiene que apagarse a mano y con intención, no quedarse
// encendido mandándole a una sola persona los correos de todos.
const REDIRIGIR_A = process.env.EMAIL_REDIRIGIR_A || null;

const marcarReenvio = ({ para, asunto, html, texto }) => ({
  para: REDIRIGIR_A,
  asunto: `[Reenviar a ${para}] ${asunto}`,
  html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#FFF4ED;border:2px solid #FF5C00;border-radius:12px;padding:16px;margin-bottom:20px">
        <p style="margin:0 0 6px;font-size:13px;color:#9A3412;font-weight:800;letter-spacing:.5px">
          REENVIAR ESTE CORREO A:
        </p>
        <p style="margin:0;font-size:20px;font-weight:800;color:#111827">${para}</p>
        <p style="margin:8px 0 0;font-size:12px;color:#6B7280">
          Llega aquí porque VoyCorriendo todavía no tiene dominio verificado en Resend.
          Reenvíalo tal cual y borra este recuadro.
        </p>
      </div>
      ${html || ''}
    </div>`,
  texto: `>>> REENVIAR A: ${para} <<<

${texto || ''}`,
});

const enviarEmail = async (mensaje) => {
  let { para, asunto, html, texto } = mensaje;
  if (!para) return { ok: false, motivo: 'sin_destinatario' };
  if (!emailConfigurado()) return { ok: false, motivo: 'no_configurado' };

  if (REDIRIGIR_A && para.toLowerCase() !== REDIRIGIR_A.toLowerCase()) {
    console.log(`[email] Redirigido: era para ${para}, se manda a ${REDIRIGIR_A} para reenvío manual.`);
    ({ para, asunto, html, texto } = marcarReenvio({ para, asunto, html, texto }));
  }
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


// Aviso de que el perfil quedó aprobado. Es el momento en que la persona
// puede empezar a trabajar, así que se le dice EXACTAMENTE qué hacer ahora:
// un correo que solo felicita no sirve de nada.
const emailPerfilAprobado = (nombre, tipo) => {
  const esRepartidor = tipo === 'repartidor';
  const queSigue = esRepartidor
    ? 'Abre la app, cambia a <b>modo repartidor</b> desde tu perfil y conéctate para empezar a recibir pedidos.'
    : 'Abre la app, cambia a <b>modo negocio</b> desde tu perfil, carga tus productos y abre tu tienda para recibir pedidos.';
  const queSigueTexto = esRepartidor
    ? 'Abre la app, cambia a modo repartidor desde tu perfil y conectate para empezar a recibir pedidos.'
    : 'Abre la app, cambia a modo negocio desde tu perfil, carga tus productos y abre tu tienda para recibir pedidos.';

  return {
    asunto: `¡Tu perfil de ${esRepartidor ? 'repartidor' : 'negocio'} fue aprobado!`,
    texto: `Hola ${nombre || ''}, tu perfil de ${esRepartidor ? 'repartidor' : 'negocio'} en VoyCorriendo `
         + `ya fue revisado y aprobado. ${queSigueTexto}`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#FF5C00;margin:0 0 8px">VoyCorriendo</h2>
        <div style="background:#F0FDF4;border:1px solid #86EFAC;border-radius:12px;padding:18px;margin:16px 0">
          <p style="font-size:18px;font-weight:700;color:#166534;margin:0">
            ✅ Tu perfil de ${esRepartidor ? 'repartidor' : 'negocio'} fue aprobado
          </p>
        </div>
        <p style="font-size:15px;color:#111827">Hola ${nombre || ''}, ya revisamos tus documentos y todo está en orden.</p>
        <p style="font-size:15px;color:#111827">${queSigue}</p>
        <p style="font-size:13px;color:#6B7280;margin-top:20px">
          ¿Dudas? Escríbenos a <a href="mailto:voycorriendoadmin@gmail.com" style="color:#FF5C00">voycorriendoadmin@gmail.com</a>.
        </p>
      </div>`,
  };
};

module.exports = { enviarEmail, emailConfigurado, emailCodigoReset, emailPerfilAprobado };
