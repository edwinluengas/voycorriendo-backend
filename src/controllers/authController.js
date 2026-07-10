const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const twilio = require('twilio');
const Usuario = require('../models/Usuario');

// Genera JWT
const generarToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// Genera OTP de 6 dígitos
const generarOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

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

    const otp = generarOTP();
    const otpExpira = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

    // Solo exigimos OTP cuando Twilio esta realmente configurado.
    // Mientras no haya credenciales de Twilio, auto-activamos al usuario
    // sin importar el valor de NODE_ENV (evita quedar bloqueados en Railway).
    const esProduccion = process.env.NODE_ENV === 'production' && !!process.env.TWILIO_ACCOUNT_SID;
    const estadoInicial = esProduccion ? 'pendiente' : 'activo';

    const usuario = await Usuario.create({
      nombre,
      apellido,
      telefono,
      email,
      password,
      rol: rol || 'cliente',
      estado: estadoInicial,
      telefono_verificado: !esProduccion,
      otp_codigo: esProduccion ? otp : null,
      otp_expira: esProduccion ? otpExpira : null,
    });

    if (esProduccion) {
      try {
        await enviarSMS(telefono, `Tu código de VoyCorriendo es: ${otp}. Válido 10 minutos. No lo compartas.`);
      } catch (smsErr) {
        console.error(`[SMS] Error enviando OTP a ${telefono}:`, smsErr.message);
        return res.status(500).json({ ok: false, mensaje: 'No pudimos enviar el código SMS. Intenta de nuevo.' });
      }
      console.log(`[PROD] OTP enviado por SMS a ${telefono}`);
      return res.status(201).json({
        ok: true,
        mensaje: 'Registro exitoso. Te enviamos un código por SMS para verificar tu número.',
        data: { usuario_id: usuario.id, telefono: usuario.telefono },
      });
    }

    // En desarrollo: regresamos JWT directo para entrar sin OTP
    const token = generarToken(usuario.id);
    console.log(`[DEV] Usuario registrado y auto-activado: ${telefono} (rol: ${usuario.rol})`);

    res.status(201).json({
      ok: true,
      mensaje: '¡Cuenta creada! Bienvenido a VoyCorriendo.',
      data: {
        token,
        usuario: {
          id: usuario.id,
          nombre: usuario.nombre,
          apellido: usuario.apellido,
          telefono: usuario.telefono,
          email: usuario.email,
          rol: usuario.rol,
          modo_activo: usuario.modo_activo,
          estado: usuario.estado,
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
    if (usuario.otp_codigo !== otp) {
      return res.status(400).json({ ok: false, mensaje: 'Código incorrecto.' });
    }
    if (new Date() > usuario.otp_expira) {
      return res.status(400).json({ ok: false, mensaje: 'El código ha expirado. Solicita uno nuevo.' });
    }

    await usuario.update({
      telefono_verificado: true,
      estado: 'activo',
      otp_codigo: null,
      otp_expira: null,
    });

    const token = generarToken(usuario.id);
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
    const usuario = await Usuario.findOne({
      where: { telefono },
    });

    if (!usuario || !(await usuario.verificarPassword(password))) {
      return res.status(401).json({ ok: false, mensaje: 'Teléfono o contraseña incorrectos.' });
    }

    // Solo bloqueamos por OTP cuando Twilio esta realmente configurado.
    const esProduccion = process.env.NODE_ENV === 'production' && !!process.env.TWILIO_ACCOUNT_SID;

    // Auto-verificamos usuarios de registros viejos (sin OTP) cuando no hay Twilio
    if (!esProduccion && (!usuario.telefono_verificado || usuario.estado !== 'activo')) {
      await usuario.update({ telefono_verificado: true, estado: 'activo' });
      console.log(`[DEV] Usuario auto-verificado en login: ${telefono}`);
    }

    if (esProduccion && !usuario.telefono_verificado) {
      return res.status(403).json({ ok: false, mensaje: 'Verifica tu número de teléfono primero.' });
    }
    if (esProduccion && usuario.estado !== 'activo') {
      return res.status(403).json({ ok: false, mensaje: 'Tu cuenta no está activa. Contacta a soporte.' });
    }

    await usuario.update({ ultima_conexion: new Date() });

    const token = generarToken(usuario.id);
    res.json({
      ok: true,
      mensaje: `¡Bienvenido de vuelta, ${usuario.nombre}!`,
      data: {
        token,
        usuario: {
          id: usuario.id,
          nombre: usuario.nombre,
          apellido: usuario.apellido,
          telefono: usuario.telefono,
          email: usuario.email,
          rol: usuario.rol,
          modo_activo: usuario.modo_activo,
          estado: usuario.estado,
        },
      },
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al iniciar sesión.' });
  }
};

// ─── POST /api/auth/solicitar-otp ───────────────────────
// (Para login sin password o recuperación)
const solicitarOTP = async (req, res) => {
  try {
    const { telefono } = req.body;
    const usuario = await Usuario.findOne({ where: { telefono } });
    if (!usuario) {
      return res.status(404).json({ ok: false, mensaje: 'No encontramos una cuenta con ese número.' });
    }

    const otp = generarOTP();
    await usuario.update({
      otp_codigo: otp,
      otp_expira: new Date(Date.now() + 10 * 60 * 1000),
    });

    try {
      await enviarSMS(telefono, `Tu código de acceso VoyCorriendo: ${otp}. Válido 10 minutos.`);
    } catch (smsErr) {
      console.error(`[SMS] Error enviando OTP a ${telefono}:`, smsErr.message);
    }
    console.log(`[SMS] OTP solicitado para ${telefono}`);

    res.json({ ok: true, mensaje: 'Te enviamos un código por SMS.' });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al enviar el código.' });
  }
};

// ─── GET /api/auth/perfil ────────────────────────────────
const obtenerPerfil = async (req, res) => {
  res.json({ ok: true, data: { usuario: req.usuario } });
};

module.exports = { registro, verificarOTP, login, solicitarOTP, obtenerPerfil };
