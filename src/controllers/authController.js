const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomInt } = require('crypto');
const { validationResult } = require('express-validator');
const twilio = require('twilio');
const Usuario = require('../models/Usuario');

const MAX_OTP_INTENTOS = 5;

// Genera JWT incluyendo tokenVersion para poder invalidar sesiones
const generarToken = (usuario) =>
  jwt.sign(
    { id: usuario.id, tokenVersion: usuario.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

// Genera OTP de 6 dígitos con entropía criptográfica
const generarOTP = () => randomInt(100000, 1000000).toString();

// Cliente Twilio (solo si está configurado)
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Envía OTP por SMS — agrega +52 automáticamente para números mexicanos de 10 dígitos
const enviarSMS = async (telefono, mensaje) => {
  if (!twilioClient) return;
  const destino = /^\+/.test(telefono) ? telefono : `+52${telefono}`;
  await twilioClient.messages.create({
    body: mensaje,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: destino,
  });
};

// ─── POST /api/auth/registro ─────────────────────────────
const registro = async (req, res) => {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ ok: false, errores: errores.array() });
  }
  try {
    const { nombre, apellido, telefono, email, password, rol } = req.body;

    const existe = await Usuario.findOne({ where: { telefono } });
    if (existe) {
      return res.status(409).json({ ok: false, mensaje: 'Ya existe una cuenta con ese número de teléfono.' });
    }

    const esProduccion = process.env.NODE_ENV === 'production' && !!process.env.TWILIO_ACCOUNT_SID;
    const estadoInicial = esProduccion ? 'pendiente' : 'activo';

    let otpPlano = null;
    let otpHash = null;
    let otpExpira = null;

    if (esProduccion) {
      otpPlano = generarOTP();
      otpHash  = await bcrypt.hash(otpPlano, 10);
      otpExpira = new Date(Date.now() + 10 * 60 * 1000);
    }

    const usuario = await Usuario.create({
      nombre, apellido, telefono, email, password,
      rol: rol || 'cliente',
      estado: estadoInicial,
      telefono_verificado: !esProduccion,
      otp_codigo: otpHash,
      otp_expira: otpExpira,
    });

    if (esProduccion) {
      try {
        await enviarSMS(telefono, `Tu código de VoyCorriendo es: ${otpPlano}. Válido 10 minutos. No lo compartas.`);
      } catch (smsErr) {
        console.error(`[SMS] Error enviando OTP a ***${telefono.slice(-4)}:`, smsErr.message);
        return res.status(500).json({ ok: false, mensaje: 'No pudimos enviar el código SMS. Intenta de nuevo.' });
      }
      console.log(`[PROD] OTP enviado por SMS a ***${telefono.slice(-4)}`);
      return res.status(201).json({
        ok: true,
        mensaje: 'Registro exitoso. Te enviamos un código por SMS para verificar tu número.',
        data: { usuario_id: usuario.id, telefono: usuario.telefono },
      });
    }

    // Desarrollo: JWT directo sin OTP
    const token = generarToken(usuario);
    console.log(`[DEV] Usuario registrado y auto-activado: ***${telefono.slice(-4)} (rol: ${usuario.rol})`);

    res.status(201).json({
      ok: true,
      mensaje: '¡Cuenta creada! Bienvenido a VoyCorriendo.',
      data: {
        token,
        usuario: {
          id: usuario.id, nombre: usuario.nombre, apellido: usuario.apellido,
          telefono: usuario.telefono, email: usuario.email,
          rol: usuario.rol, modo_activo: usuario.modo_activo, estado: usuario.estado,
        },
      },
    });
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ ok: false, mensaje: 'Ocurrió un error. Intenta de nuevo.' });
  }
};

// ─── POST /api/auth/verificar-otp ───────────────────────
const verificarOTP = async (req, res) => {
  try {
    const { telefono, otp } = req.body;
    const usuario = await Usuario.findOne({ where: { telefono } });

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
    const { telefono, password } = req.body;
    const usuario = await Usuario.findOne({ where: { telefono } });

    if (!usuario || !(await usuario.verificarPassword(password))) {
      return res.status(401).json({ ok: false, mensaje: 'Teléfono o contraseña incorrectos.' });
    }

    const esProduccion = process.env.NODE_ENV === 'production' && !!process.env.TWILIO_ACCOUNT_SID;

    if (!esProduccion && (!usuario.telefono_verificado || usuario.estado !== 'activo')) {
      await usuario.update({ telefono_verificado: true, estado: 'activo' });
      console.log(`[DEV] Usuario auto-verificado en login: ***${telefono.slice(-4)}`);
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
          telefono: usuario.telefono, email: usuario.email,
          rol: usuario.rol, modo_activo: usuario.modo_activo, estado: usuario.estado,
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
    const { telefono } = req.body;
    const usuario = await Usuario.findOne({ where: { telefono } });
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
      await enviarSMS(telefono, `Tu código de acceso VoyCorriendo: ${otpPlano}. Válido 10 minutos.`);
    } catch (smsErr) {
      console.error(`[SMS] Error enviando OTP a ***${telefono.slice(-4)}:`, smsErr.message);
    }
    console.log(`[SMS] OTP solicitado para ***${telefono.slice(-4)}`);

    res.json({ ok: true, mensaje: 'Si ese número está registrado, te enviamos un código.' });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al enviar el código.' });
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

module.exports = { registro, verificarOTP, login, solicitarOTP, obtenerPerfil, logout };
