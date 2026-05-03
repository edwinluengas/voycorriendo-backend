const { Usuario, Repartidor, Negocio } = require('../models');

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
        'id', 'nombre', 'activo', 'estado_cuenta', 'estado_motivo',
        'calificacion_promedio', 'total_pedidos', 'destacado_calidad',
      ],
    });

    const rolNegocio = negocio
      ? {
          activo: true,
          estado: mapearEstadoNegocio(negocio.activo, negocio.estado_cuenta),
          aprobado: negocio.activo,
          estado_cuenta: negocio.estado_cuenta,
          mensaje: construirMensajeNegocio(negocio.activo, negocio.estado_cuenta, negocio.estado_motivo),
          nombre: negocio.nombre,
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

    // Negocio: solo si esta activo (admin lo aprobo)
    if (modo === 'negocio') {
      const negocio = await Negocio.findOne({ where: { usuario_id: usuarioId } });
      if (!negocio) {
        return res.status(403).json({
          ok: false,
          mensaje: 'Aun no tienes un negocio. Registra uno desde tu perfil.',
        });
      }
      if (!negocio.activo) {
        return res.status(403).json({
          ok: false,
          mensaje: 'Tu negocio aun esta en revision por el equipo de VoyCorriendo.',
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

function mapearEstadoNegocio(activo, estadoCuenta) {
  if (estadoCuenta === 'bloqueado') return 'bloqueado';
  if (estadoCuenta === 'suspendido') return 'suspendido';
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

function construirMensajeNegocio(activo, estadoCuenta, motivo) {
  if (estadoCuenta === 'observacion') {
    return 'Tu negocio esta en observacion. Mejora tus tiempos y calificacion.';
  }
  if (estadoCuenta === 'suspendido') {
    return motivo || 'Tu negocio esta suspendido temporalmente.';
  }
  if (estadoCuenta === 'bloqueado') {
    return motivo || 'Tu negocio fue bloqueado permanentemente.';
  }
  if (!activo) return 'Tu negocio esta en revision por el equipo de VoyCorriendo.';
  return null;
}

module.exports = {
  obtenerMisRoles,
  cambiarModo,
};
