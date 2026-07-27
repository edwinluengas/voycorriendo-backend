const jwt = require('jsonwebtoken');
const Usuario = require('../models/Usuario');

// Verifica que el token JWT sea válido
const proteger = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      return res.status(401).json({ ok: false, mensaje: 'No tienes acceso. Inicia sesión primero.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const usuario = await Usuario.findByPk(decoded.id);
    if (!usuario) {
      return res.status(401).json({ ok: false, mensaje: 'Este usuario ya no existe.' });
    }
    if (usuario.estado === 'suspendido') {
      return res.status(403).json({ ok: false, mensaje: 'Tu cuenta ha sido suspendida. Contacta a soporte.' });
    }
    // Cuenta bloqueada temporalmente por intentos fallidos: el token que ya
    // tuviera en la mano tampoco debe servir mientras dure el bloqueo.
    if (usuario.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > new Date()) {
      return res.status(403).json({
        ok: false,
        mensaje: 'Tu cuenta está bloqueada temporalmente por intentos de acceso fallidos.',
        codigo: 'CUENTA_BLOQUEADA',
      });
    }
    // Verificar versión del token (revocación via logout o cambio de contraseña)
    const tokenVersion = decoded.tokenVersion ?? 0;
    if (tokenVersion !== (usuario.token_version ?? 0)) {
      return res.status(401).json({ ok: false, mensaje: 'Sesión expirada. Vuelve a iniciar sesión.' });
    }
    req.usuario = usuario;
    // El token de un admin que completó el segundo factor lleva `dosFactores`.
    // soloAdmin lo exige: un token viejo (de antes del 2FA) o uno emitido a
    // medio camino no alcanza para entrar al panel.
    req.tokenTiene2FA = decoded.dosFactores === true;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, mensaje: 'Token inválido o expirado. Vuelve a iniciar sesión.' });
  }
};

// Restringe acceso por rol — acepta si el modo_activo (toggle de UI) O el
// rol de registro coinciden. Evita bloquear cuentas cuyo modo_activo quedó
// desincronizado de su rol real (p. ej. modo_activo nunca se actualizó al
// registrarse como repartidor/negocio y quedó en el default 'cliente').
const restringirA = (...roles) => {
  return (req, res, next) => {
    const rolesUsuario = [req.usuario.modo_activo, req.usuario.rol].filter(Boolean);
    const autorizado = rolesUsuario.some((r) => roles.includes(r));
    if (!autorizado) {
      return res.status(403).json({
        ok: false,
        mensaje: `No tienes permiso para realizar esta acción. Rol requerido: ${roles.join(', ')}.`,
      });
    }
    next();
  };
};

// ─── Candado estricto para el panel de administración ─────
// A diferencia de restringirA('admin'), esto NO acepta `modo_activo`: exige
// el rol REAL de la cuenta. `modo_activo` es un toggle de UI que se escribe
// desde una ruta de usuario normal — hoy tiene lista blanca y no permite
// 'admin', pero basta un descuido futuro ahí para regalar el panel entero.
// El privilegio más alto del sistema no debe depender de eso.
//
// Además: exige que el token haya pasado por el segundo factor (claim `2fa`)
// cuando la cuenta lo tiene activo, y deja bitácora de cada acción.
const soloAdmin = async (req, res, next) => {
  const usuario = req.usuario;
  if (!usuario || usuario.rol !== 'admin') {
    // Se registra el intento: alguien tocando /api/admin sin ser admin es
    // señal de sondeo, no un error del día a día.
    try {
      const { logAdmin } = require('../utils/audit');
      await logAdmin({
        adminId: usuario?.id || null,
        accion: 'acceso_admin_denegado',
        entidadTipo: 'auth',
        entidadId: usuario?.id || null,
        estadoDespues: { ruta: req.originalUrl, metodo: req.method },
        ip: req.ip,
      });
    } catch (_) {}
    return res.status(403).json({
      ok: false,
      mensaje: 'No tienes permiso para entrar al panel de administración.',
    });
  }

  if (usuario.admin_2fa_activo && !req.tokenTiene2FA) {
    return res.status(403).json({
      ok: false,
      mensaje: 'Tu sesión no completó la verificación en dos pasos. Vuelve a iniciar sesión.',
      codigo: 'REQUIERE_2FA',
    });
  }

  // Bitácora de acciones que cambian algo (las lecturas serían ruido).
  if (req.method !== 'GET') {
    try {
      const { logAdmin } = require('../utils/audit');
      await logAdmin({
        adminId: usuario.id,
        accion: 'accion_admin',
        entidadTipo: 'admin_api',
        entidadId: null,
        estadoDespues: { ruta: req.originalUrl, metodo: req.method },
        ip: req.ip,
      });
    } catch (_) {}
  }

  next();
};

module.exports = { proteger, restringirA, soloAdmin };
