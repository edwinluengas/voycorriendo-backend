/**
 * Candados de seguridad para cuentas administrador — VoyCorriendo
 * ------------------------------------------------------------------
 * El panel admin puede aprobar cuentas, otorgar crédito, borrar pérdidas y
 * ver datos personales de todos. Robarse un acceso admin es el peor
 * escenario posible del sistema, así que aquí vive todo lo que lo dificulta:
 *
 *   1. Segundo factor obligatorio (código de un solo uso) en cada login.
 *      Se manda por Telegram (canal más confiable hoy), SMS y correo.
 *   2. Bloqueo temporal de la CUENTA tras varios intentos fallidos — el
 *      límite por IP no basta: un atacante con muchas IPs lo esquiva.
 *   3. Alerta inmediata al admin por Telegram de cada login, cada intento
 *      fallido y cada acción sensible, con IP y dispositivo.
 *   4. Bitácora en `audit_logs` de todo lo anterior.
 *
 * Recuperación si el admin se queda fuera (sin bypass en la API):
 *   node src/scripts/admin-seguridad.js <telefono> desbloquear
 *   node src/scripts/admin-seguridad.js <telefono> 2fa-off
 */
const { randomInt } = require('crypto');
const bcrypt = require('bcryptjs');
const tg = require('./telegram.service');
const { enviarEmail, emailConfigurado } = require('./email.service');

const num = (clave, def) => {
  const raw = process.env[clave];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

// Intentos fallidos antes de bloquear la cuenta. El admin tiene menos
// margen que un cliente: su cuenta vale mucho más.
const MAX_INTENTOS_ADMIN   = num('MAX_INTENTOS_ADMIN', 3);
const MAX_INTENTOS_NORMAL  = num('MAX_INTENTOS_LOGIN', 8);
const BLOQUEO_MIN_ADMIN    = num('BLOQUEO_MIN_ADMIN', 30);
const BLOQUEO_MIN_NORMAL   = num('BLOQUEO_MIN_LOGIN', 15);
// Vigencia del código de segundo factor
const VIGENCIA_2FA_MIN     = num('VIGENCIA_2FA_MIN', 10);
const MAX_INTENTOS_2FA     = num('MAX_INTENTOS_2FA', 3);
// La sesión de admin dura mucho menos que la de un cliente: si le roban el
// token, la ventana de uso es corta.
const EXPIRACION_TOKEN_ADMIN = process.env.JWT_EXPIRES_ADMIN || '8h';

const esAdmin = (usuario) => usuario?.rol === 'admin' || usuario?.modo_activo === 'admin';

const generarCodigo = () => randomInt(0, 1000000).toString().padStart(6, '0');

// IP real detrás del proxy de Railway (app.set('trust proxy', 1))
const ipDe = (req) => req?.ip || req?.headers?.['x-forwarded-for'] || 'desconocida';
const dispositivoDe = (req) => String(req?.headers?.['user-agent'] || 'desconocido').slice(0, 120);

// ─── Bitácora ─────────────────────────────────────────────
// Nunca lanza: una falla al escribir la bitácora no debe tumbar el login.
const registrarEvento = async ({ usuario, accion, req, detalle = {} }) => {
  const { logAdmin } = require('../utils/audit');
  await logAdmin({
    adminId:       usuario?.id || null,
    accion,
    entidadTipo:   'auth',
    entidadId:     usuario?.id || null,
    estadoDespues: { ...detalle, dispositivo: dispositivoDe(req) },
    ip:            ipDe(req),
  });
};

// ─── Alertas ──────────────────────────────────────────────
// Al chat del propio admin y al chat de administración configurado. Si a
// alguien le roban la cuenta, el dueño se entera en segundos.
const alertar = async (usuario, mensaje) => {
  try {
    if (usuario?.telegram_chat_id) await tg.enviar(usuario.telegram_chat_id, mensaje).catch(() => {});
    await tg.enviarAdmin(mensaje).catch(() => {});
  } catch (_) {}
};

// ─── Bloqueo por intentos fallidos ────────────────────────
const estaBloqueada = (usuario) =>
  !!(usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > new Date());

const minutosRestantes = (usuario) =>
  Math.max(1, Math.ceil((new Date(usuario.bloqueado_hasta) - new Date()) / 60000));

const registrarIntentoFallido = async (usuario, req) => {
  const admin    = esAdmin(usuario);
  const maximo   = admin ? MAX_INTENTOS_ADMIN : MAX_INTENTOS_NORMAL;
  const castigo  = admin ? BLOQUEO_MIN_ADMIN : BLOQUEO_MIN_NORMAL;
  const intentos = (usuario.intentos_fallidos || 0) + 1;

  if (intentos >= maximo) {
    await usuario.update({
      intentos_fallidos: 0,
      bloqueado_hasta: new Date(Date.now() + castigo * 60 * 1000),
    });
    await registrarEvento({ usuario, accion: 'login_bloqueado', req, detalle: { intentos, minutos: castigo } });
    if (admin) {
      await alertar(usuario,
        `🚨 <b>CUENTA ADMIN BLOQUEADA</b>\n${intentos} intentos fallidos de contraseña.\n`
        + `IP: <code>${ipDe(req)}</code>\nDispositivo: ${dispositivoDe(req)}\n`
        + `Bloqueada ${castigo} minutos. Si no fuiste tú, alguien está intentando entrar.`);
    }
    return { bloqueada: true, minutos: castigo };
  }

  await usuario.update({ intentos_fallidos: intentos });
  await registrarEvento({ usuario, accion: 'login_fallido', req, detalle: { intentos } });
  if (admin) {
    await alertar(usuario,
      `⚠️ <b>Intento fallido en tu cuenta admin</b>\nIntento ${intentos} de ${maximo}.\n`
      + `IP: <code>${ipDe(req)}</code>\nDispositivo: ${dispositivoDe(req)}`);
  }
  return { bloqueada: false, restantes: maximo - intentos };
};

const limpiarIntentos = async (usuario) => {
  if (usuario.intentos_fallidos || usuario.bloqueado_hasta) {
    await usuario.update({ intentos_fallidos: 0, bloqueado_hasta: null });
  }
};

// ─── Segundo factor ───────────────────────────────────────
// Devuelve a qué canales se logró entregar. Si NINGUNO funcionó, el login
// se rechaza: sin bypass. Para eso existe el script de recuperación.
const enviarCodigo2FA = async (usuario, req) => {
  const codigo = generarCodigo();
  await usuario.update({
    login2fa_codigo:   await bcrypt.hash(codigo, 10),
    login2fa_expira:   new Date(Date.now() + VIGENCIA_2FA_MIN * 60 * 1000),
    login2fa_intentos: 0,
  });

  const canales = [];
  const texto = `🔐 <b>Código para entrar como administrador</b>\n\n<code>${codigo}</code>\n\n`
    + `Vence en ${VIGENCIA_2FA_MIN} minutos.\nIP: <code>${ipDe(req)}</code>\n`
    + `Si no estás entrando tú, cambia tu contraseña AHORA.`;

  if (usuario.telegram_chat_id) {
    try { await tg.enviar(usuario.telegram_chat_id, texto); canales.push('Telegram'); }
    catch (e) { console.warn('[seguridad] 2FA Telegram falló:', e.message); }
  }
  // El chat de administración configurado sirve de respaldo — es el mismo
  // dueño, y sin él un admin sin Telegram vinculado y con SMS en trial se
  // quedaría sin forma de entrar.
  if (canales.length === 0 && process.env.TELEGRAM_ADMIN_CHAT_ID) {
    try { await tg.enviarAdmin(texto); canales.push('Telegram'); }
    catch (e) { console.warn('[seguridad] 2FA Telegram admin falló:', e.message); }
  }

  try {
    const { enviarSMSSeguro } = require('./sms.service');
    await enviarSMSSeguro(usuario, `VoyCorriendo: tu codigo de administrador es ${codigo}. Vence en ${VIGENCIA_2FA_MIN} min.`);
    canales.push('SMS');
  } catch (e) {
    console.warn('[seguridad] 2FA SMS falló:', e.message);
  }

  if (usuario.email && emailConfigurado()) {
    const r = await enviarEmail({
      para: usuario.email,
      asunto: `Código de administrador VoyCorriendo: ${codigo}`,
      texto: `Tu código para entrar al panel de administración es ${codigo}. Vence en ${VIGENCIA_2FA_MIN} minutos. IP del intento: ${ipDe(req)}.`,
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#FF5C00">Código de administrador</h2>
        <div style="font-size:36px;font-weight:800;letter-spacing:8px;text-align:center;
                    background:#F8F9FA;border:1px solid #E5E7EB;border-radius:12px;padding:18px">${codigo}</div>
        <p style="color:#6B7280;font-size:13px">Vence en ${VIGENCIA_2FA_MIN} minutos. IP del intento: ${ipDe(req)}.
        Si no fuiste tú, cambia tu contraseña de inmediato.</p></div>`,
    });
    if (r.ok) canales.push('correo');
  }

  await registrarEvento({ usuario, accion: '2fa_enviado', req, detalle: { canales } });
  return canales;
};

const verificarCodigo2FA = async (usuario, codigo, req) => {
  if (!usuario.login2fa_codigo || !usuario.login2fa_expira) {
    return { ok: false, mensaje: 'No hay ningún código pendiente. Inicia sesión de nuevo.' };
  }
  if (new Date() > usuario.login2fa_expira) {
    await usuario.update({ login2fa_codigo: null, login2fa_expira: null, login2fa_intentos: 0 });
    return { ok: false, mensaje: 'El código venció. Inicia sesión de nuevo.' };
  }
  if ((usuario.login2fa_intentos || 0) >= MAX_INTENTOS_2FA) {
    await usuario.update({ login2fa_codigo: null, login2fa_expira: null, login2fa_intentos: 0 });
    await alertar(usuario, `🚨 <b>Códigos de administrador agotados</b>\nAlguien falló ${MAX_INTENTOS_2FA} veces el segundo factor.\nIP: <code>${ipDe(req)}</code>`);
    await registrarEvento({ usuario, accion: '2fa_agotado', req });
    return { ok: false, mensaje: 'Demasiados intentos con el código. Inicia sesión de nuevo.' };
  }
  if (!(await bcrypt.compare(String(codigo), usuario.login2fa_codigo))) {
    await usuario.update({ login2fa_intentos: (usuario.login2fa_intentos || 0) + 1 });
    await registrarEvento({ usuario, accion: '2fa_fallido', req });
    return { ok: false, mensaje: 'Código incorrecto.' };
  }
  await usuario.update({ login2fa_codigo: null, login2fa_expira: null, login2fa_intentos: 0 });
  return { ok: true };
};

// ─── Login exitoso de admin ───────────────────────────────
const registrarLoginAdmin = async (usuario, req) => {
  await usuario.update({ ultimo_login_ip: ipDe(req), ultima_conexion: new Date() });
  await registrarEvento({ usuario, accion: 'login_admin_exitoso', req });
  await alertar(usuario,
    `✅ <b>Entraste al panel de administración</b>\n`
    + `IP: <code>${ipDe(req)}</code>\nDispositivo: ${dispositivoDe(req)}\n`
    + `Hora: ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}\n\n`
    + `Si NO fuiste tú, cambia tu contraseña de inmediato.`);
};

module.exports = {
  esAdmin, ipDe, dispositivoDe,
  registrarEvento, alertar,
  estaBloqueada, minutosRestantes, registrarIntentoFallido, limpiarIntentos,
  enviarCodigo2FA, verificarCodigo2FA, registrarLoginAdmin,
  EXPIRACION_TOKEN_ADMIN, VIGENCIA_2FA_MIN,
  MAX_INTENTOS_ADMIN, MAX_INTENTOS_NORMAL, BLOQUEO_MIN_ADMIN, BLOQUEO_MIN_NORMAL,
};
