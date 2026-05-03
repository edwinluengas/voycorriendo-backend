const { Repartidor, Usuario, Pedido } = require('../models');
const { validationResult } = require('express-validator');
const { subirImagen } = require('../services/storage.service');

// ─── POST /api/repartidores/activar ───────────────────────
// Cuando el usuario da clic en "Activar modo repartidor" en su
// perfil, creamos una fila vacia en estado 'pendiente' para
// que pueda empezar el wizard de onboarding.
const activarModo = async (req, res) => {
  try {
    const yaExiste = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (yaExiste) {
      return res.json({
        ok: true,
        mensaje: 'Ya tienes un perfil de repartidor.',
        data: { repartidor: yaExiste },
      });
    }
    const repartidor = await Repartidor.create({
      usuario_id: req.usuario.id,
      verificacion_estado: 'pendiente',
      ciudad: 'puerto_escondido',
    });
    res.status(201).json({
      ok: true,
      mensaje: 'Modo repartidor activado. Completa tus datos para empezar.',
      data: { repartidor },
    });
  } catch (error) {
    console.error('Error en activarModo:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al activar modo repartidor.' });
  }
};

// ─── PATCH /api/repartidores/perfil ────────────────────────
// Actualiza datos del wizard. Acepta cualquier subset de campos
// para que el wizard pueda guardar paso a paso.
const actualizarPerfil = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Aun no eres repartidor. Activa el modo desde tu perfil.',
      });
    }
    if (['suspendido', 'bloqueado'].includes(repartidor.estado_cuenta)) {
      return res.status(403).json({
        ok: false,
        mensaje: 'Tu cuenta esta restringida. Contacta a soporte.',
      });
    }

    const camposEditables = [
      'tipo_vehiculo', 'marca_vehiculo', 'modelo_vehiculo',
      'anio_vehiculo', 'placa_vehiculo', 'color_vehiculo',
      'clabe_bancaria', 'banco',
      // URLs de fotos (las setea /foto, pero permitimos override)
      'foto_ine_frente', 'foto_ine_reverso',
      'foto_licencia', 'foto_tarjeta_circulacion',
    ];
    camposEditables.forEach(c => {
      if (req.body[c] !== undefined) repartidor[c] = req.body[c];
    });
    await repartidor.save();

    res.json({ ok: true, mensaje: 'Datos guardados.', data: { repartidor } });
  } catch (error) {
    console.error('Error en actualizarPerfil:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar tus datos.' });
  }
};

// ─── POST /api/repartidores/foto ───────────────────────────
// Sube una foto a Supabase Storage y guarda la URL en la
// columna correspondiente. Body: { tipo, base64, mime }
//   tipo: 'ine_frente' | 'ine_reverso' | 'licencia' | 'tarjeta_circulacion'
const subirFoto = async (req, res) => {
  try {
    const { tipo, base64, mime } = req.body;
    const tiposValidos = {
      ine_frente: 'foto_ine_frente',
      ine_reverso: 'foto_ine_reverso',
      licencia: 'foto_licencia',
      tarjeta_circulacion: 'foto_tarjeta_circulacion',
    };
    const columna = tiposValidos[tipo];
    if (!columna) {
      return res.status(400).json({ ok: false, mensaje: 'Tipo de foto invalido.' });
    }
    if (!base64 || !mime) {
      return res.status(400).json({ ok: false, mensaje: 'Falta base64 o mime.' });
    }

    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) {
      return res.status(404).json({ ok: false, mensaje: 'Activa primero el modo repartidor.' });
    }

    // Subimos a Supabase Storage
    const ext = mime.split('/')[1] || 'jpg';
    const ruta = `repartidores/${req.usuario.id}/${tipo}_${Date.now()}.${ext}`;
    const url = await subirImagen('documentos-repartidores', ruta, base64, mime);

    repartidor[columna] = url;
    await repartidor.save();

    res.json({ ok: true, mensaje: 'Foto subida.', data: { url, tipo } });
  } catch (error) {
    console.error('Error en subirFoto:', error);
    res.status(500).json({
      ok: false,
      mensaje: error.message || 'No se pudo subir la foto. Intenta de nuevo.',
    });
  }
};

// ─── POST /api/repartidores/enviar-a-revision ──────────────
// El repartidor termina el wizard y manda su solicitud al admin.
const enviarARevision = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) {
      return res.status(404).json({ ok: false, mensaje: 'Perfil no encontrado.' });
    }
    // Validar que tenga lo minimo
    const faltantes = [];
    if (!repartidor.tipo_vehiculo) faltantes.push('tipo de vehiculo');
    if (!repartidor.placa_vehiculo) faltantes.push('placa');
    if (!repartidor.clabe_bancaria) faltantes.push('CLABE');
    if (!repartidor.foto_ine_frente) faltantes.push('foto INE frente');
    if (!repartidor.foto_ine_reverso) faltantes.push('foto INE reverso');
    if (!repartidor.foto_licencia) faltantes.push('foto licencia');
    if (faltantes.length) {
      return res.status(400).json({
        ok: false,
        mensaje: `Faltan datos: ${faltantes.join(', ')}.`,
      });
    }
    repartidor.verificacion_estado = 'en_revision';
    await repartidor.save();

    res.json({
      ok: true,
      mensaje: '¡Listo! Estamos revisando tus documentos. Te avisaremos en menos de 48 horas.',
      data: { repartidor },
    });
  } catch (error) {
    console.error('Error en enviarARevision:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al enviar a revision.' });
  }
};

// ─── PATCH /api/repartidores/conectarse ────────────────────
// "Go Online" estilo Uber. Solo recibira pedidos si conectado=true
// Y verificacion_estado='aprobado' Y estado_cuenta NOT IN (suspendido, bloqueado)
const conectarse = async (req, res) => {
  try {
    const { conectado, latitud, longitud } = req.body;
    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) {
      return res.status(404).json({ ok: false, mensaje: 'No eres repartidor.' });
    }
    if (conectado && repartidor.verificacion_estado !== 'aprobado') {
      return res.status(403).json({
        ok: false,
        mensaje: 'Tu cuenta aun no ha sido aprobada por el equipo.',
      });
    }
    if (conectado && ['suspendido', 'bloqueado'].includes(repartidor.estado_cuenta)) {
      return res.status(403).json({
        ok: false,
        mensaje: `Tu cuenta esta ${repartidor.estado_cuenta}. Contacta a soporte.`,
      });
    }

    repartidor.conectado = !!conectado;
    repartidor.conectado_desde = conectado ? new Date() : null;
    if (latitud != null) repartidor.latitud = latitud;
    if (longitud != null) repartidor.longitud = longitud;
    if (!conectado) repartidor.disponible = false;  // si se desconecta, ya no esta disponible
    await repartidor.save();

    // Notificar via socket.io para el panel admin
    const io = req.app.get('io');
    io.emit('repartidor_conexion', {
      repartidor_id: repartidor.id,
      conectado: repartidor.conectado,
    });

    res.json({
      ok: true,
      mensaje: conectado ? '¡Estas en linea! Espera tu primer pedido.' : 'Te desconectaste.',
      data: { conectado: repartidor.conectado },
    });
  } catch (error) {
    console.error('Error en conectarse:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al cambiar conexion.' });
  }
};

// ─── POST /api/repartidores/perfil ─────────────────────────
// (Endpoint legacy: crea perfil completo en una sola llamada.
// Lo dejamos por compatibilidad. Para el wizard nuevo usar
// /activar + /perfil PATCH + /enviar-a-revision.)
const crearPerfil = async (req, res) => {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ ok: false, errores: errores.array() });
  }
  try {
    const yaExiste = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (yaExiste) {
      return res.status(409).json({ ok: false, mensaje: 'Ya tienes un perfil de repartidor.' });
    }

    const {
      tipo_vehiculo, marca_vehiculo, modelo_vehiculo,
      anio_vehiculo, placa_vehiculo, color_vehiculo,
      clabe_bancaria, banco,
    } = req.body;

    const repartidor = await Repartidor.create({
      usuario_id: req.usuario.id,
      tipo_vehiculo,
      marca_vehiculo,
      modelo_vehiculo,
      anio_vehiculo,
      placa_vehiculo,
      color_vehiculo,
      clabe_bancaria,
      banco,
      verificacion_estado: 'pendiente',
    });

    res.status(201).json({
      ok: true,
      mensaje: 'Perfil creado. Sube tus documentos para completar la verificación.',
      data: { repartidor },
    });
  } catch (error) {
    console.error('Error al crear perfil repartidor:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al crear tu perfil.' });
  }
};

// ─── PATCH /api/repartidores/disponibilidad ───────────────
// Mantiene compatibilidad. Internamente requiere conectado=true.
const actualizarDisponibilidad = async (req, res) => {
  try {
    const { disponible, latitud, longitud } = req.body;
    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });

    if (!repartidor || repartidor.verificacion_estado !== 'aprobado') {
      return res.status(403).json({
        ok: false,
        mensaje: 'Tu cuenta aún no ha sido verificada. Espera la aprobación del equipo.',
      });
    }
    if (!repartidor.conectado) {
      return res.status(403).json({
        ok: false,
        mensaje: 'Conectate primero para poder recibir pedidos.',
      });
    }

    await repartidor.update({ disponible, latitud, longitud });

    const io = req.app.get('io');
    io.emit('repartidor_disponibilidad', {
      repartidor_id: repartidor.id,
      disponible, lat: latitud, lng: longitud,
    });

    res.json({
      ok: true,
      mensaje: disponible ? '¡Estás en línea! Recibirás pedidos.' : 'Te pusiste en pausa.',
      data: { disponible, latitud, longitud },
    });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar disponibilidad.' });
  }
};

// ─── GET /api/repartidores/mis-entregas ───────────────────
const misEntregas = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) return res.status(404).json({ ok: false, mensaje: 'Perfil no encontrado.' });

    const entregas = await Pedido.findAll({
      where: { repartidor_id: repartidor.id },
      order: [['creado_en', 'DESC']],
      limit: 50,
    });

    const entregadas = entregas.filter(p => p.estado === 'entregado');
    const ganancias = entregadas.reduce((sum, p) => sum + parseFloat(p.costo_envio || 0) * 0.8, 0);

    res.json({
      ok: true,
      data: {
        entregas,
        resumen: {
          total_entregas: entregadas.length,
          ganancias_estimadas: ganancias.toFixed(2),
          calificacion_promedio: repartidor.calificacion_promedio,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener entregas.' });
  }
};

// ─── GET /api/repartidores/pedidos-disponibles ───────────
// Ahora exige conectado=true (no solo disponible)
const pedidosDisponibles = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({
      where: {
        usuario_id: req.usuario.id,
        conectado: true,
        verificacion_estado: 'aprobado',
      },
    });
    if (!repartidor) {
      return res.status(403).json({
        ok: false,
        mensaje: 'Conectate primero para ver pedidos disponibles.',
      });
    }
    if (['suspendido', 'bloqueado'].includes(repartidor.estado_cuenta)) {
      return res.status(403).json({
        ok: false,
        mensaje: `Tu cuenta esta ${repartidor.estado_cuenta}.`,
      });
    }

    const pedidos = await Pedido.findAll({
      where: { estado: 'listo', repartidor_id: null },
      order: [['creado_en', 'ASC']],
      limit: 10,
    });

    res.json({ ok: true, data: { pedidos } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener pedidos disponibles.' });
  }
};

// ─── POST /api/repartidores/aceptar-pedido ────────────────
const aceptarPedido = async (req, res) => {
  try {
    const { pedido_id } = req.body;
    const repartidor = await Repartidor.findOne({
      where: { usuario_id: req.usuario.id, verificacion_estado: 'aprobado' },
    });
    if (!repartidor) return res.status(403).json({ ok: false, mensaje: 'Sin acceso.' });

    const pedido = await Pedido.findOne({
      where: { id: pedido_id, estado: 'listo', repartidor_id: null },
    });
    if (!pedido) {
      return res.status(409).json({ ok: false, mensaje: 'Este pedido ya fue tomado por otro repartidor.' });
    }

    await pedido.update({
      repartidor_id: repartidor.id,
      estado: 'en_camino',
      asignado_en: new Date(),
    });

    const io = req.app.get('io');
    io.to(`pedido:${pedido.id}`).emit('repartidor_asignado', {
      pedido_id: pedido.id,
      repartidor_id: repartidor.id,
    });

    res.json({ ok: true, mensaje: '¡Pedido aceptado! Ve a recogerlo.', data: { pedido } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al aceptar el pedido.' });
  }
};

module.exports = {
  // Onboarding nuevo
  activarModo,
  actualizarPerfil,
  subirFoto,
  enviarARevision,
  conectarse,
  // Operacion
  crearPerfil,                  // legacy
  actualizarDisponibilidad,
  misEntregas,
  pedidosDisponibles,
  aceptarPedido,
};
