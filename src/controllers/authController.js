const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomInt } = require('crypto');
const { validationResult } = require('express-validator');
const twilio = require('twilio');
const Usuario = require('../models/Usuario');
const { normalizarTelefono, telefonoValido, aE164, enmascarar, LADA_DEFAULT, PAIS_DEFAULT } = require('../utils/telefono');
const { enviarEmail, emailConfigurado, emailCodigoReset } = require('../services/email.service');

const MAX_OTP_INTENTOS = 5;
const MAX_RESET_INTENTOS = 5;
const RESET_VIGENCIA_MIN = 15;

// Genera JWT incluyendo tokenVersion para poder invalidar sesiones
const generarToken = (usuario) =>
  jwt.sign(
    { id: usuario.id, tokenVersion: usuario.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

// Genera OTP de 6 dígitos con entropía criptográfica
const generarOTP = () => randomInt(0, 1000000).toString().padStart(6, '0');

// Cliente Twilio (solo si está configurado)
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Envía SMS en formato E.164 usando la lada real de la cuenta (ya no se
// asume +52: Puerto Escondido tiene clientes extranjeros).
const enviarSMS = async ({ telefono, lada }, mensaje) => {
  if (!twilioClient) throw new Error('SMS no configurado en el servidor.');
  await twilioClient.messages.create({
    body: mensaje,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: aE164({ lada, telefono }),
  });
};

// Busca por el par (lada, teléfono). Las cuentas creadas antes de que
// existiera la columna `lada` quedaron con el default '52', y los APK ya
// instalados no mandan el campo (también cae en '52') — así que para los
// usuarios mexicanos el comportamiento es idéntico al de siempre.
const buscarPorTelefono = ({ lada, telefono }) =>
  Usuario.findOne({ where: { telefono, lada: lada || LADA_DEFAULT } });

// ─── POST /api/auth/registro ─────────────────────────────
const registro = async (req, res) => {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ ok: false, errores: errores.array() });
  }
  try {
    const { nombre, apellido, email, password, rol, acepto_terminos, acepta_marketing } = req.body;

    if (!acepto_terminos) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Debes aceptar los Términos de Uso y el Aviso de Privacidad para crear tu cuenta.',
      });
    }

    // Teléfono internacional: (lada, número nacional). Sin lada → México.
    const { lada, telefono } = normalizarTelefono(req.body.telefono, req.body.lada);
    const pais = String(req.body.pais || PAIS_DEFAULT).toUpperCase().slice(0, 2);
    const chequeo = telefonoValido({ lada, telefono });
    if (!chequeo.ok) {
      return res.status(400).json({ ok: false, mensaje: chequeo.mensaje, campo: 'telefono' });
    }

    const existe = await Usuario.findOne({ where: { telefono, lada } });
    if (existe) {
      return res.status(409).json({
        ok: false,
        mensaje: `Ya existe una cuenta con el número +${lada} ${telefono}. Inicia sesión o recupera tu contraseña.`,
        codigo: 'TELEFONO_YA_REGISTRADO',
        campo: 'telefono',
      });
    }
    if (email) {
      const emailUsado = await Usuario.findOne({ where: { email: String(email).trim().toLowerCase() } });
      if (emailUsado) {
        return res.status(409).json({
          ok: false,
          mensaje: `El correo ${email} ya está usado por otra cuenta. Usa otro o recupera tu contraseña.`,
          codigo: 'EMAIL_YA_REGISTRADO',
          campo: 'email',
        });
      }
    }

    // Siempre activar la cuenta inmediatamente — OTP es informativo mientras Twilio esté en trial
    const rolFinal = rol || 'cliente';
    const usuario = await Usuario.create({
      nombre, apellido, telefono, lada, pais,
      email: email ? String(email).trim().toLowerCase() : null,
      password,
      rol: rolFinal,
      // modo_activo debe arrancar igual al rol de registro — si no, el usuario
      // queda con modo_activo='cliente' (default de columna) aunque se haya
      // registrado como repartidor/negocio, y la app lo manda al stack equivocado.
      modo_activo: rolFinal,
      estado: 'activo',
      telefono_verificado: true,
      acepto_terminos: true,
      terminos_aceptados_en: new Date(),
      acepta_marketing: !!acepta_marketing,
    });

    // Intentar enviar OTP por SMS de forma asíncrona (no bloquea el registro)
    if (process.env.TWILIO_ACCOUNT_SID) {
      const otpPlano = generarOTP();
      bcrypt.hash(otpPlano, 10).then(async (otpHash) => {
        await usuario.update({
          otp_codigo: otpHash,
          otp_expira: new Date(Date.now() + 10 * 60 * 1000),
        });
        enviarSMS({ telefono, lada }, `Tu código de verificación VoyCorriendo es: ${otpPlano}. Válido 10 minutos.`)
          .then(() => console.log(`[SMS] OTP enviado a ${enmascarar({ lada, telefono })}`))
          .catch((err) => console.warn(`[OTP-FALLBACK] Código para ${enmascarar({ lada, telefono })}: ${otpPlano} — SMS falló: ${err.message}`));
      }).catch(() => {});
    }

    const token = generarToken(usuario);
    console.log(`[REGISTRO] Usuario activado: ${enmascarar({ lada, telefono })} (rol: ${usuario.rol})`);

    res.status(201).json({
      ok: true,
      mensaje: '¡Cuenta creada! Bienvenido a VoyCorriendo.',
      data: {
        token,
        usuario: {
          id: usuario.id, nombre: usuario.nombre, apellido: usuario.apellido,
          telefono: usuario.telefono, lada: usuario.lada, pais: usuario.pais, email: usuario.email,
          rol: usuario.rol, modo_activo: usuario.modo_activo, estado: usuario.estado,
          credito_disponible: parseFloat(usuario.credito_disponible || 0),
        },
      },
    });
  } catch (error) {
    console.error('Error en registro:', error);
    // El usuario debe VER qué falló, no un "no pudimos conectarnos".
    // Los errores de validación/unicidad de Sequelize son culpa del dato que
    // escribió y son perfectamente explicables sin filtrar nada interno.
    if (error.name === 'SequelizeUniqueConstraintError') {
      const campo = error.errors?.[0]?.path || '';
      const mensaje = campo.includes('email')
        ? 'Ese correo ya está registrado en otra cuenta.'
        : 'Ese número de teléfono ya está registrado.';
      return res.status(409).json({ ok: false, mensaje, campo, codigo: 'DUPLICADO' });
    }
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({
        ok: false,
        mensaje: error.errors?.map((e) => e.message).join('. ') || 'Revisa los datos del formulario.',
        codigo: 'VALIDACION',
      });
    }
    res.status(500).json({
      ok: false,
      mensaje: 'No pudimos crear tu cuenta. Intenta de nuevo en un momento.',
      codigo: 'ERROR_SERVIDOR',
      // Detalle técnico solo fuera de producción — en prod queda en los logs.
      ...(process.env.NODE_ENV !== 'production' ? { _debug: error.message } : {}),
    });
  }
};

// ─── POST /api/auth/verificar-otp ───────────────────────
const verificarOTP = async (req, res) => {
  try {
    const { otp } = req.body;
    const { lada, telefono } = normalizarTelefono(req.body.telefono, req.body.lada);
    const usuario = await buscarPorTelefono({ lada, telefono });

    if (!usuario) {
      return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado.' });
    }

    // Verificar expiración primero (sin revelar si el código existe)
    if (!usuario.otp_codigo || !usuario.otp_expira || new Date() > usuario.otp_expira) {
      return res.status(400).json({ ok: false, mensaje: 'El código ha expirado. Solicita uno nuevo.' });
    }

    // Brute force: máximo MAX_OTP_INTENTOS por usuario
    if ((usuario.otp_intentos || 0) >= MAX_OTP_INTENTOS) {
      await usuario.update({ otp_codigo: null, otp_expira: null, otp_intentos: 0 });
      return res.status(429).json({
        ok: false,
        mensaje: `Demasiados intentos incorrectos. Solicita un nuevo código.`,
      });
    }

    // Comparar con hash bcrypt
    const esValido = await bcrypt.compare(String(otp), usuario.otp_codigo);
    if (!esValido) {
      await usuario.update({ otp_intentos: (usuario.otp_intentos || 0) + 1 });
      const restantes = MAX_OTP_INTENTOS - (usuario.otp_intentos + 1);
      return res.status(400).json({
        ok: false,
        mensaje: restantes > 0
          ? `Código incorrecto. Te quedan ${restantes} intento${restantes !== 1 ? 's' : ''}.`
          : 'Código incorrecto. Solicita un nuevo código.',
      });
    }

    await usuario.update({
      telefono_verificado: true,
      estado: 'activo',
      otp_codigo: null,
      otp_expira: null,
      otp_intentos: 0,
    });

    const token = generarToken(usuario);
    res.json({
      ok: true,
      mensaje: '¡Número verificado! Bienvenido a VoyCorriendo 🎉',
      token,
      data: { usuario },
    });
  } catch (error) {
    console.error('Error en verificarOTP:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al verificar el código.' });
  }
};

// ─── POST /api/auth/login ────────────────────────────────
const login = async (req, res) => {
  try {
    const { password } = req.body;
    const { lada, telefono } = normalizarTelefono(req.body.telefono, req.body.lada);
    const usuario = await buscarPorTelefono({ lada, telefono });

    // Decisión explícita del dueño de la plataforma (2026-07-25): distinguir
    // "no existe cuenta" de "contraseña incorrecta" para poder ofrecer
    // "crear cuenta nueva" en el frontend. Antes el mensaje era
    // deliberadamente genérico (evita que alguien pruebe números de
    // teléfono para descubrir cuáles están registrados) — se acepta ese
    // trade-off de seguridad a cambio de mejor UX.
    if (!usuario) {
      return res.status(404).json({
        ok: false,
        mensaje: `No encontramos una cuenta con el número +${lada} ${telefono}.`,
        codigo: 'USUARIO_NO_ENCONTRADO',
      });
    }
    if (!(await usuario.verificarPassword(password))) {
      return res.status(401).json({ ok: false, mensaje: 'Contraseña incorrecta.' });
    }

    const esProduccion = process.env.NODE_ENV === 'production' && !!process.env.TWILIO_ACCOUNT_SID;

    if (!esProduccion && (!usuario.telefono_verificado || usuario.estado !== 'activo')) {
      await usuario.update({ telefono_verificado: true, estado: 'activo' });
      console.log(`[DEV] Usuario auto-verificado en login: ${enmascarar({ lada, telefono })}`);
    }

    if (esProduccion && !usuario.telefono_verificado) {
      return res.status(403).json({ ok: false, mensaje: 'Verifica tu número de teléfono primero.' });
    }
    if (esProduccion && usuario.estado !== 'activo') {
      return res.status(403).json({ ok: false, mensaje: 'Tu cuenta no está activa. Contacta a soporte.' });
    }

    await usuario.update({ ultima_conexion: new Date() });

    const token = generarToken(usuario);
    res.json({
      ok: true,
      mensaje: `¡Bienvenido de vuelta, ${usuario.nombre}!`,
      data: {
        token,
        usuario: {
          id: usuario.id, nombre: usuario.nombre, apellido: usuario.apellido,
          telefono: usuario.telefono, lada: usuario.lada, pais: usuario.pais, email: usuario.email,
          rol: usuario.rol, modo_activo: usuario.modo_activo, estado: usuario.estado,
          credito_disponible: parseFloat(usuario.credito_disponible || 0),
        },
      },
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al iniciar sesión.' });
  }
};

// ─── POST /api/auth/solicitar-otp ───────────────────────
const solicitarOTP = async (req, res) => {
  try {
    const { lada, telefono } = normalizarTelefono(req.body.telefono, req.body.lada);
    const usuario = await buscarPorTelefono({ lada, telefono });
    if (!usuario) {
      // No revelar si el número existe o no
      return res.json({ ok: true, mensaje: 'Si ese número está registrado, te enviamos un código.' });
    }

    const otpPlano = generarOTP();
    const otpHash  = await bcrypt.hash(otpPlano, 10);

    await usuario.update({
      otp_codigo: otpHash,
      otp_expira: new Date(Date.now() + 10 * 60 * 1000),
      otp_intentos: 0,
    });

    try {
      await enviarSMS({ telefono, lada }, `Tu código de acceso VoyCorriendo: ${otpPlano}. Válido 10 minutos.`);
    } catch (smsErr) {
      console.error(`[SMS] Error enviando OTP a ${enmascarar({ lada, telefono })}:`, smsErr.message);
    }
    console.log(`[SMS] OTP solicitado para ${enmascarar({ lada, telefono })}`);

    res.json({ ok: true, mensaje: 'Si ese número está registrado, te enviamos un código.' });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al enviar el código.' });
  }
};

// ─── POST /api/auth/recuperar-password ───────────────────
// Envía un código de 6 dígitos por SMS y/o email. Body:
//   { telefono, lada, canal?: 'sms' | 'email' | 'ambos' }
// o { email, canal: 'email' } si el usuario solo recuerda su correo.
//
// Nunca revela si la cuenta existe (evita que alguien pruebe números para
// descubrir quién está registrado), PERO sí es explícito cuando el canal
// pedido no está disponible en el servidor — eso no filtra nada del usuario
// y sin ese aviso el flujo parecería roto sin explicación.
const recuperarPassword = async (req, res) => {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ ok: false, mensaje: errores.array()[0].msg, errores: errores.array() });
  }
  try {
    const canal = ['sms', 'email', 'ambos'].includes(req.body.canal) ? req.body.canal : 'sms';
    const emailBuscado = req.body.email ? String(req.body.email).trim().toLowerCase() : null;

    let usuario = null;
    let lada = LADA_DEFAULT, telefono = '';
    if (req.body.telefono) {
      ({ lada, telefono } = normalizarTelefono(req.body.telefono, req.body.lada));
      usuario = await buscarPorTelefono({ lada, telefono });
    } else if (emailBuscado) {
      usuario = await Usuario.findOne({ where: { email: emailBuscado } });
    } else {
      return res.status(400).json({ ok: false, mensaje: 'Escribe tu número de celular o tu correo.' });
    }

    if ((canal === 'email' || canal === 'ambos') && !emailConfigurado()) {
      return res.status(503).json({
        ok: false,
        mensaje: 'El envío por correo todavía no está habilitado. Recibe tu código por SMS.',
        codigo: 'EMAIL_NO_CONFIGURADO',
      });
    }

    const respuestaNeutra = {
      ok: true,
      mensaje: canal === 'email'
        ? 'Si esa cuenta existe, te enviamos un código a tu correo.'
        : 'Si esa cuenta existe, te enviamos un código por SMS.',
      vigencia_min: RESET_VIGENCIA_MIN,
    };
    if (!usuario) return res.json(respuestaNeutra);

    if ((canal === 'email' || canal === 'ambos') && !usuario.email) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Tu cuenta no tiene correo registrado. Recibe el código por SMS.',
        codigo: 'SIN_EMAIL',
      });
    }

    const codigo = generarOTP();
    await usuario.update({
      reset_codigo:   await bcrypt.hash(codigo, 10),
      reset_expira:   new Date(Date.now() + RESET_VIGENCIA_MIN * 60 * 1000),
      reset_intentos: 0,
    });

    const destino = { telefono: usuario.telefono, lada: usuario.lada || LADA_DEFAULT };
    let enviadoSMS = false, enviadoEmail = false;
    const fallos = [];

    if (canal === 'sms' || canal === 'ambos') {
      try {
        await enviarSMS(destino, `VoyCorriendo: tu código para cambiar tu contraseña es ${codigo}. Vence en ${RESET_VIGENCIA_MIN} minutos.`);
        enviadoSMS = true;
      } catch (e) {
        fallos.push(`SMS: ${e.message}`);
        console.error(`[reset] SMS falló a ${enmascarar(destino)}:`, e.message);
      }
    }
    if ((canal === 'email' || canal === 'ambos') && usuario.email) {
      const plantilla = emailCodigoReset(codigo, usuario.nombre);
      const r = await enviarEmail({ para: usuario.email, ...plantilla });
      enviadoEmail = r.ok;
      if (!r.ok) fallos.push(`Email: ${r.motivo}`);
    }

    if (!enviadoSMS && !enviadoEmail) {
      // Aquí SÍ hay que ser claro: la cuenta existe y aún así no salió nada.
      // Callarlo dejaría al usuario esperando un código que nunca llega.
      console.error('[reset] No se pudo entregar el código:', fallos.join(' | '));
      return res.status(502).json({
        ok: false,
        mensaje: 'No pudimos enviarte el código en este momento. Intenta con el otro método o escríbenos a soporte.',
        codigo: 'ENVIO_FALLIDO',
      });
    }

    console.log(`[reset] Código enviado a ${enmascarar(destino)} (sms=${enviadoSMS}, email=${enviadoEmail})`);
    res.json({
      ok: true,
      mensaje: enviadoSMS && enviadoEmail ? 'Te enviamos un código por SMS y correo.'
        : enviadoSMS ? 'Te enviamos un código por SMS.'
        : 'Te enviamos un código a tu correo.',
      vigencia_min: RESET_VIGENCIA_MIN,
      // Pistas enmascaradas para que el usuario sepa a dónde llegó el código
      destino: {
        telefono: enviadoSMS ? `+${destino.lada} ***${destino.telefono.slice(-4)}` : null,
        email: enviadoEmail && usuario.email
          ? usuario.email.replace(/^(.).*(@.*)$/, (_, a, b) => `${a}***${b}`)
          : null,
      },
    });
  } catch (error) {
    console.error('Error en recuperarPassword:', error);
    res.status(500).json({ ok: false, mensaje: 'No pudimos procesar tu solicitud. Intenta de nuevo.' });
  }
};

// ─── POST /api/auth/restablecer-password ─────────────────
// Body: { telefono, lada, codigo, password } — o { email, codigo, password }
const restablecerPassword = async (req, res) => {
  const erroresValidacion = validationResult(req);
  if (!erroresValidacion.isEmpty()) {
    return res.status(400).json({ ok: false, mensaje: erroresValidacion.array()[0].msg, errores: erroresValidacion.array() });
  }
  try {
    const { codigo, password } = req.body;
    if (!codigo || !password) {
      return res.status(400).json({ ok: false, mensaje: 'Falta el código o la contraseña nueva.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ ok: false, mensaje: 'La contraseña nueva debe tener mínimo 8 caracteres.', campo: 'password' });
    }

    let usuario = null;
    if (req.body.telefono) {
      const { lada, telefono } = normalizarTelefono(req.body.telefono, req.body.lada);
      usuario = await buscarPorTelefono({ lada, telefono });
    } else if (req.body.email) {
      usuario = await Usuario.findOne({ where: { email: String(req.body.email).trim().toLowerCase() } });
    }

    // Mensaje idéntico para "no existe" y "código inválido": no se puede usar
    // este endpoint para averiguar qué cuentas existen.
    const invalido = () => res.status(400).json({
      ok: false,
      mensaje: 'El código no es válido o ya venció. Solicita uno nuevo.',
      codigo: 'CODIGO_INVALIDO',
    });

    if (!usuario || !usuario.reset_codigo || !usuario.reset_expira) return invalido();
    if (new Date() > usuario.reset_expira) {
      await usuario.update({ reset_codigo: null, reset_expira: null, reset_intentos: 0 });
      return invalido();
    }
    if ((usuario.reset_intentos || 0) >= MAX_RESET_INTENTOS) {
      await usuario.update({ reset_codigo: null, reset_expira: null, reset_intentos: 0 });
      return res.status(429).json({
        ok: false,
        mensaje: 'Demasiados intentos con código incorrecto. Solicita un código nuevo.',
        codigo: 'DEMASIADOS_INTENTOS',
      });
    }

    if (!(await bcrypt.compare(String(codigo), usuario.reset_codigo))) {
      await usuario.update({ reset_intentos: (usuario.reset_intentos || 0) + 1 });
      const restantes = MAX_RESET_INTENTOS - (usuario.reset_intentos + 1);
      return res.status(400).json({
        ok: false,
        mensaje: restantes > 0
          ? `Código incorrecto. Te queda${restantes !== 1 ? 'n' : ''} ${restantes} intento${restantes !== 1 ? 's' : ''}.`
          : 'Código incorrecto. Solicita un código nuevo.',
        codigo: 'CODIGO_INVALIDO',
      });
    }

    // Contraseña nueva + invalidación de TODAS las sesiones abiertas
    // (token_version): si alguien más tenía la cuenta, queda fuera.
    await usuario.update({
      password,
      reset_codigo: null,
      reset_expira: null,
      reset_intentos: 0,
      token_version: (usuario.token_version ?? 0) + 1,
      telefono_verificado: true,
      estado: usuario.estado === 'pendiente' ? 'activo' : usuario.estado,
    });

    const token = generarToken(usuario);
    console.log(`[reset] Contraseña restablecida para ${enmascarar({ lada: usuario.lada, telefono: usuario.telefono })}`);

    res.json({
      ok: true,
      mensaje: '¡Listo! Tu contraseña se cambió y ya iniciaste sesión.',
      data: {
        token,
        usuario: {
          id: usuario.id, nombre: usuario.nombre, apellido: usuario.apellido,
          telefono: usuario.telefono, lada: usuario.lada, pais: usuario.pais, email: usuario.email,
          rol: usuario.rol, modo_activo: usuario.modo_activo, estado: usuario.estado,
          credito_disponible: parseFloat(usuario.credito_disponible || 0),
        },
      },
    });
  } catch (error) {
    console.error('Error en restablecerPassword:', error);
    res.status(500).json({ ok: false, mensaje: 'No pudimos cambiar tu contraseña. Intenta de nuevo.' });
  }
};

// ─── GET /api/auth/perfil ────────────────────────────────
const obtenerPerfil = async (req, res) => {
  res.json({ ok: true, data: { usuario: req.usuario } });
};

// ─── POST /api/auth/logout ───────────────────────────────
// Invalida el JWT actual incrementando token_version.
// El cliente debe eliminar su token local.
const logout = async (req, res) => {
  try {
    await req.usuario.update({ token_version: (req.usuario.token_version ?? 0) + 1 });
    res.json({ ok: true, mensaje: 'Sesión cerrada.' });
  } catch (error) {
    console.error('Error en logout:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al cerrar sesión.' });
  }
};

module.exports = {
  registro, verificarOTP, login, solicitarOTP, obtenerPerfil, logout,
  recuperarPassword, restablecerPassword,
};
