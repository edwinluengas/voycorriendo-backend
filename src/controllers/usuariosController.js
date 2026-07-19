const { Usuario, Repartidor, Negocio, Pedido } = require('../models');
const { Op } = require('sequelize');

// ─── GET /api/usuarios/mis-roles ─────────────────────────────
// Devuelve que modos tiene activos el usuario y su estado.
// Estructura pensada para que el frontend dibuje los switches
// del perfil y decida que tabs mostrar segun modo_activo.
const obtenerMisRoles = async (req, res) => {
  try {
    const usuarioId = req.usuario.id;

    // Cliente: siempre activo (todos los usuarios pueden pedir)
    const cliente = {
      activo: true,
      estado: 'aprobado',
      mensaje: null,
    };

    // Repartidor: activo si existe fila en repartidores
    const repartidor = await Repartidor.findOne({
      where: { usuario_id: usuarioId },
      attributes: [
        'id', 'verificacion_estado', 'verificacion_nota',
        'estado_cuenta', 'estado_motivo',
        'conectado', 'disponible',
        'calificacion_promedio', 'total_entregas',
      ],
    });

    const rolRepartidor = repartidor
      ? {
          activo: true,
          estado: mapearEstadoRol(repartidor.verificacion_estado, repartidor.estado_cuenta),
          verificacion: repartidor.verificacion_estado,
          estado_cuenta: repartidor.estado_cuenta,
          mensaje: construirMensajeRol(repartidor.verificacion_estado, repartidor.estado_cuenta, repartidor.estado_motivo),
          conectado: repartidor.conectado,
          calificacion: parseFloat(repartidor.calificacion_promedio),
          total_entregas: repartidor.total_entregas,
        }
      : { activo: false, estado: 'inactivo', mensaje: null };

    // Negocio: activo si existe fila en negocios
    const negocio = await Negocio.findOne({
      where: { usuario_id: usuarioId },
      attributes: [
        'id', 'nombre', 'activo', 'verificacion_estado', 'verificacion_nota',
        'estado_cuenta', 'estado_motivo', 'abierto_ahora',
        'calificacion_promedio', 'total_pedidos', 'destacado_calidad',
      ],
    });

    const rolNegocio = negocio
      ? {
          activo: true,
          estado: mapearEstadoNegocio(negocio.verificacion_estado, negocio.activo, negocio.estado_cuenta),
          verificacion: negocio.verificacion_estado,
          aprobado: negocio.activo,
          estado_cuenta: negocio.estado_cuenta,
          mensaje: construirMensajeNegocio(
            negocio.verificacion_estado, negocio.activo,
            negocio.estado_cuenta, negocio.estado_motivo,
            negocio.verificacion_nota
          ),
          nombre: negocio.nombre,
          abierto: negocio.abierto_ahora,
          calificacion: parseFloat(negocio.calificacion_promedio),
          total_pedidos: negocio.total_pedidos,
          destacado_calidad: negocio.destacado_calidad,
        }
      : { activo: false, estado: 'inactivo', mensaje: null };

    res.json({
      ok: true,
      data: {
        modo_activo: req.usuario.modo_activo || 'cliente',
        roles: { cliente, repartidor: rolRepartidor, negocio: rolNegocio },
      },
    });
  } catch (error) {
    console.error('Error en obtenerMisRoles:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener tus roles.' });
  }
};

// ─── POST /api/usuarios/cambiar-modo ─────────────────────────
// Cambia el modo activo del usuario. Solo permite cambiar a un
// modo que el usuario tenga aprobado.
const cambiarModo = async (req, res) => {
  try {
    const { modo } = req.body;
    if (!['cliente', 'repartidor', 'negocio'].includes(modo)) {
      return res.status(400).json({ ok: false, mensaje: 'Modo invalido.' });
    }

    const usuarioId = req.usuario.id;

    // Cliente siempre se permite
    if (modo === 'cliente') {
      req.usuario.modo_activo = 'cliente';
      await req.usuario.save();
      return res.json({ ok: true, data: { modo_activo: 'cliente' } });
    }

    // Repartidor: solo si esta aprobado
    if (modo === 'repartidor') {
      const repartidor = await Repartidor.findOne({ where: { usuario_id: usuarioId } });
      if (!repartidor) {
        return res.status(403).json({
          ok: false,
          mensaje: 'Aun no eres repartidor. Activa el modo desde tu perfil.',
        });
      }
      if (repartidor.verificacion_estado !== 'aprobado') {
        return res.status(403).json({
          ok: false,
          mensaje: 'Tu cuenta de repartidor aun esta en revision.',
        });
      }
      if (['suspendido', 'bloqueado'].includes(repartidor.estado_cuenta)) {
        return res.status(403).json({
          ok: false,
          mensaje: `Tu cuenta de repartidor esta ${repartidor.estado_cuenta}. Contacta a soporte.`,
        });
      }
    }

    // Negocio: permitimos entrar si ya activo el modo (aunque este pendiente)
    // para que vea el dashboard con su estado. La validacion fina ocurre en
    // cada endpoint operativo.
    if (modo === 'negocio') {
      const negocio = await Negocio.findOne({ where: { usuario_id: usuarioId } });
      if (!negocio) {
        return res.status(403).json({
          ok: false,
          mensaje: 'Aun no tienes un negocio. Activalo desde tu perfil.',
        });
      }
      if (['suspendido', 'bloqueado'].includes(negocio.estado_cuenta)) {
        return res.status(403).json({
          ok: false,
          mensaje: `Tu negocio esta ${negocio.estado_cuenta}. Contacta a soporte.`,
        });
      }
    }

    req.usuario.modo_activo = modo;
    await req.usuario.save();
    res.json({ ok: true, data: { modo_activo: modo } });
  } catch (error) {
    console.error('Error en cambiarModo:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al cambiar de modo.' });
  }
};

// ─── Helpers ─────────────────────────────────────────────────

// Estado simple para el frontend (verde/amarillo/rojo)
function mapearEstadoRol(verificacion, estadoCuenta) {
  if (estadoCuenta === 'bloqueado') return 'bloqueado';
  if (estadoCuenta === 'suspendido') return 'suspendido';
  if (verificacion === 'pendiente' || verificacion === 'en_revision') return 'pendiente';
  if (verificacion === 'rechazado') return 'rechazado';
  if (verificacion === 'aprobado') return 'aprobado';
  return 'inactivo';
}

function mapearEstadoNegocio(verificacion, activo, estadoCuenta) {
  if (estadoCuenta === 'bloqueado') return 'bloqueado';
  if (estadoCuenta === 'suspendido') return 'suspendido';
  if (verificacion === 'pendiente')   return 'pendiente';
  if (verificacion === 'en_revision') return 'pendiente';
  if (verificacion === 'rechazado')   return 'rechazado';
  if (verificacion === 'aprobado' && activo) return 'aprobado';
  // Negocios viejos sin verificacion_estado: usar 'activo'
  if (!activo) return 'pendiente';
  return 'aprobado';
}

function construirMensajeRol(verificacion, estadoCuenta, motivo) {
  if (estadoCuenta === 'observacion') {
    return 'Tu cuenta esta en observacion. Mejora tu calificacion para evitar restricciones.';
  }
  if (estadoCuenta === 'probation') {
    return 'Recibiras menos pedidos por bajo desempeno. Mejora tus indicadores.';
  }
  if (estadoCuenta === 'suspendido') {
    return motivo || 'Tu cuenta esta suspendida temporalmente. Contacta a soporte.';
  }
  if (estadoCuenta === 'bloqueado') {
    return motivo || 'Tu cuenta ha sido bloqueada permanentemente.';
  }
  if (verificacion === 'pendiente') return 'Sube tus documentos para empezar a trabajar.';
  if (verificacion === 'en_revision') return 'Estamos revisando tus documentos. Te avisaremos pronto.';
  if (verificacion === 'rechazado') return motivo || 'Tus documentos fueron rechazados. Vuelve a subirlos.';
  if (verificacion === 'aprobado') return null;
  return null;
}

function construirMensajeNegocio(verificacion, activo, estadoCuenta, motivo, nota) {
  if (estadoCuenta === 'observacion') {
    return 'Tu negocio esta en observacion. Mejora tus tiempos y calificacion.';
  }
  if (estadoCuenta === 'suspendido') {
    return motivo || 'Tu negocio esta suspendido temporalmente.';
  }
  if (estadoCuenta === 'bloqueado') {
    return motivo || 'Tu negocio fue bloqueado permanentemente.';
  }
  if (verificacion === 'pendiente')   return 'Completa los datos de tu negocio para enviarlo a revision.';
  if (verificacion === 'en_revision') return 'Estamos revisando tu negocio. Te avisaremos pronto.';
  if (verificacion === 'rechazado')   return nota || 'Tu negocio fue rechazado. Corrige los datos y vuelve a enviar.';
  if (verificacion === 'aprobado' && activo) return null;
  if (!activo) return 'Tu negocio esta en revision por el equipo de VoyCorriendo.';
  return null;
}

// ─── GET /api/usuarios/mis-direcciones ───────────────────────
const misDirecciones = async (req, res) => {
  res.json({ ok: true, data: { direcciones: req.usuario.direcciones_guardadas || [] } });
};

// ─── POST /api/usuarios/mis-direcciones ──────────────────────
const agregarDireccion = async (req, res) => {
  try {
    const { nombre, direccion, notas } = req.body;
    if (!nombre?.trim() || !direccion?.trim()) {
      return res.status(400).json({ ok: false, mensaje: 'Nombre y dirección son requeridos.' });
    }
    const dirs = [...(req.usuario.direcciones_guardadas || [])];
    if (dirs.length >= 5) {
      return res.status(400).json({ ok: false, mensaje: 'Máximo 5 direcciones guardadas.' });
    }
    const nueva = {
      id: Date.now().toString(),
      nombre: nombre.trim(),
      direccion: direccion.trim(),
      notas: notas?.trim() || '',
      creada_en: new Date().toISOString(),
    };
    dirs.push(nueva);
    await req.usuario.update({ direcciones_guardadas: dirs });
    res.json({ ok: true, data: { direcciones: dirs } });
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar dirección.' });
  }
};

// ─── DELETE /api/usuarios/mis-direcciones/:id ─────────────────
const eliminarDireccion = async (req, res) => {
  try {
    const dirs = (req.usuario.direcciones_guardadas || []).filter(d => d.id !== req.params.id);
    await req.usuario.update({ direcciones_guardadas: dirs });
    res.json({ ok: true, data: { direcciones: dirs } });
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar dirección.' });
  }
};

// ─── GET /api/usuarios/mis-calificaciones ─────────────────────
const misCalificaciones = async (req, res) => {
  try {
    const pedidos = await Pedido.findAll({
      where: {
        cliente_id: req.usuario.id,
        estado: 'entregado',
        calificacion_negocio: { [Op.ne]: null },
      },
      attributes: [
        'id', 'numero', 'creado_en',
        'calificacion_negocio', 'calificacion_repartidor', 'comentario', 'propina',
      ],
      include: [{ model: Negocio, as: 'negocio', attributes: ['id', 'nombre'] }],
      order: [['creado_en', 'DESC']],
      limit: 50,
    });
    res.json({ ok: true, data: { calificaciones: pedidos } });
  } catch (e) {
    console.error('Error en misCalificaciones:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener calificaciones.' });
  }
};

// ─── GET /api/usuarios/metodo-pago-default ───────────────────
const getMetodoPagoDefault = async (req, res) => {
  res.json({ ok: true, data: { metodo_pago_default: req.usuario.metodo_pago_default || null } });
};

// ─── PATCH /api/usuarios/metodo-pago-default ─────────────────
const setMetodoPagoDefault = async (req, res) => {
  try {
    const { metodo } = req.body;
    const validos = ['efectivo', 'tarjeta', 'mercado_pago'];
    if (!validos.includes(metodo)) {
      return res.status(400).json({ ok: false, mensaje: 'Método de pago inválido.' });
    }
    await req.usuario.update({ metodo_pago_default: metodo });
    res.json({ ok: true, data: { metodo_pago_default: metodo } });
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar preferencia.' });
  }
};

// ─── GET /api/usuarios/notificaciones ────────────────────────
const getNotificaciones = async (req, res) => {
  res.json({
    ok: true,
    data: {
      notif_pedidos:    req.usuario.notif_pedidos    ?? true,
      notif_marketing:  req.usuario.notif_marketing  ?? false,
    },
  });
};

// ─── PATCH /api/usuarios/notificaciones ──────────────────────
const setNotificaciones = async (req, res) => {
  try {
    const campos = {};
    if (req.body.notif_pedidos   !== undefined) campos.notif_pedidos   = !!req.body.notif_pedidos;
    if (req.body.notif_marketing !== undefined) campos.notif_marketing = !!req.body.notif_marketing;
    await req.usuario.update(campos);
    res.json({ ok: true, data: campos });
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: 'Error al guardar preferencias.' });
  }
};

// ─── PATCH /api/usuarios/push-token ──────────────────────────
const guardarPushToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || !token.startsWith('ExponentPushToken')) {
      return res.status(400).json({ ok: false, mensaje: 'Token inválido.' });
    }
    await req.usuario.update({ token_push: token });
    console.log(`[push] token guardado para usuario ${req.usuario.id}: ${token.slice(0, 20)}...`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[push] Error al guardar push token:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar token.' });
  }
};

module.exports = {
  obtenerMisRoles,
  cambiarModo,
  guardarPushToken,
  misDirecciones,
  agregarDireccion,
  eliminarDireccion,
  misCalificaciones,
  getMetodoPagoDefault,
  setMetodoPagoDefault,
  getNotificaciones,
  setNotificaciones,
};
