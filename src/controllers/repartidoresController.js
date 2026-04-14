const { Repartidor, Usuario, Pedido } = require('../models');
const { validationResult } = require('express-validator');

// ─── POST /api/repartidores/perfil ────────────────────────
// El usuario (rol=repartidor) completa su perfil de repartidor
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
// El repartidor activa o desactiva su disponibilidad y envía ubicación
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

    await repartidor.update({ disponible, latitud, longitud });

    // Notificar en tiempo real (para el panel admin)
    const io = req.app.get('io');
    io.emit('repartidor_disponibilidad', {
      repartidor_id: repartidor.id,
      disponible,
      lat: latitud,
      lng: longitud,
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

    const { desde, hasta } = req.query;
    const where = { repartidor_id: repartidor.id };
    if (desde) where.creado_en = { $gte: new Date(desde) };

    const entregas = await Pedido.findAll({
      where,
      order: [['creado_en', 'DESC']],
      limit: 50,
    });

    // Calcular ganancias del período
    const entregadas = entregas.filter(p => p.estado === 'entregado');
    const ganancias = entregadas.reduce((sum, p) => sum + parseFloat(p.costo_envio) * 0.8, 0);
    // Repartidor recibe 80% del costo de envío (20% es comisión plataforma)

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
// Pedidos en estado 'listo' cercanos al repartidor
const pedidosDisponibles = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({
      where: { usuario_id: req.usuario.id, disponible: true, verificacion_estado: 'aprobado' },
    });
    if (!repartidor) {
      return res.status(403).json({ ok: false, mensaje: 'No estás disponible para recibir pedidos.' });
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

    // Notificar al cliente
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
  crearPerfil,
  actualizarDisponibilidad,
  misEntregas,
  pedidosDisponibles,
  aceptarPedido,
};
