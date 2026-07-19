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
    // Verificar versión del token (revocación via logout o cambio de contraseña)
    const tokenVersion = decoded.tokenVersion ?? 0;
    if (tokenVersion !== (usuario.token_version ?? 0)) {
      return res.status(401).json({ ok: false, mensaje: 'Sesión expirada. Vuelve a iniciar sesión.' });
    }
    req.usuario = usuario;
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

module.exports = { proteger, restringirA };
