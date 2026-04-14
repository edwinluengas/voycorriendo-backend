const { Pedido, Negocio, Repartidor, Usuario, Producto } = require('../models');
const { v4: uuidv4 } = require('uuid');

// Genera número de pedido legible: MND-004823
const generarNumeroPedido = () => {
  const num = Math.floor(1000 + Math.random() * 899000).toString().padStart(6, '0');
  return `MND-${num}`;
};

// ─── POST /api/pedidos ────────────────────────────────────
const crearPedido = async (req, res) => {
  try {
    const {
      negocio_id,
      items,               // [{ producto_id, cantidad, notas, opciones }]
      direccion_entrega,
      latitud_entrega,
      longitud_entrega,
      notas_entrega,
      metodo_pago,
    } = req.body;

    // 1. Verificar negocio existe y está abierto
    const negocio = await Negocio.findByPk(negocio_id);
    if (!negocio || !negocio.activo) {
      return res.status(400).json({ ok: false, mensaje: 'El negocio no está disponible.' });
    }

    // 2. Validar y calcular precios de los items
    let subtotal = 0;
    const itemsDetallados = [];

    for (const item of items) {
      const producto = await Producto.findOne({
        where: { id: item.producto_id, negocio_id, disponible: true },
      });
      if (!producto) {
        return res.status(400).json({
          ok: false,
          mensaje: `El producto "${item.producto_id}" no está disponible.`,
        });
      }
      const precioItem = parseFloat(producto.precio) * item.cantidad;
      subtotal += precioItem;
      itemsDetallados.push({
        producto_id: producto.id,
        nombre: producto.nombre,
        precio_unitario: producto.precio,
        cantidad: item.cantidad,
        subtotal: precioItem,
        notas: item.notas || null,
      });
    }

    // 3. Calcular costo de envío (lógica simple por ahora)
    const costo_envio = 25;  // TODO: calcular por distancia con Google Maps
    const total = subtotal + costo_envio;

    // 4. Validar límite de efectivo
    if (metodo_pago === 'efectivo' && total > 1000) {
      return res.status(400).json({
        ok: false,
        mensaje: `Los pagos en efectivo tienen un límite de $1,000 MXN. Tu pedido es de $${total.toFixed(2)}. Por favor elige tarjeta, transferencia o Mercado Pago.`,
      });
    }

    // 5. Crear el pedido
    const pedido = await Pedido.create({
      numero: generarNumeroPedido(),
      cliente_id: req.usuario.id,
      negocio_id,
      items: itemsDetallados,
      subtotal,
      costo_envio,
      total,
      metodo_pago,
      pago_estado: metodo_pago === 'efectivo' ? 'pendiente' : 'pendiente',
      direccion_entrega,
      latitud_entrega,
      longitud_entrega,
      notas_entrega,
      estado: 'pendiente',
    });

    // 6. Notificar al negocio vía Socket.io en tiempo real
    const io = req.app.get('io');
    io.to(`negocio:${negocio_id}`).emit('nuevo_pedido', {
      pedido_id: pedido.id,
      numero: pedido.numero,
      total: pedido.total,
      items: itemsDetallados,
    });

    res.status(201).json({
      ok: true,
      mensaje: '¡Pedido creado! Esperando confirmación del negocio.',
      data: { pedido },
    });
  } catch (error) {
    console.error('Error al crear pedido:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al procesar tu pedido.' });
  }
};

// ─── GET /api/pedidos ─────────────────────────────────────
// Cliente ve su historial de pedidos
const misPedidos = async (req, res) => {
  try {
    const pedidos = await Pedido.findAll({
      where: { cliente_id: req.usuario.id },
      order: [['creado_en', 'DESC']],
      limit: 20,
      include: [
        { model: Negocio, as: 'negocio', attributes: ['id', 'nombre', 'logo', 'categoria'] },
        { model: Repartidor, as: 'repartidor',
          include: [{ model: Usuario, as: 'usuario', attributes: ['nombre', 'foto_perfil', 'telefono'] }],
        },
      ],
    });
    res.json({ ok: true, data: { pedidos } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener pedidos.' });
  }
};

// ─── GET /api/pedidos/:id ─────────────────────────────────
const obtenerPedido = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, {
      include: [
        { model: Negocio, as: 'negocio', attributes: ['id', 'nombre', 'logo', 'telefono', 'direccion'] },
        { model: Repartidor, as: 'repartidor',
          attributes: ['id', 'calificacion_promedio', 'latitud', 'longitud', 'marca_vehiculo', 'color_vehiculo'],
          include: [{ model: Usuario, as: 'usuario', attributes: ['nombre', 'foto_perfil', 'telefono'] }],
        },
      ],
    });

    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    // Solo el cliente dueño, el negocio o el repartidor pueden verlo
    const esCliente   = pedido.cliente_id === req.usuario.id;
    const esRepartidor = pedido.repartidor?.usuario_id === req.usuario.id;
    const esNegocio   = req.usuario.rol === 'negocio';
    const esAdmin     = req.usuario.rol === 'admin';

    if (!esCliente && !esRepartidor && !esNegocio && !esAdmin) {
      return res.status(403).json({ ok: false, mensaje: 'No tienes acceso a este pedido.' });
    }

    res.json({ ok: true, data: { pedido } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener el pedido.' });
  }
};

// ─── PATCH /api/pedidos/:id/estado ───────────────────────
// Negocio confirma / rechaza. Repartidor actualiza a en_camino / entregado.
const actualizarEstado = async (req, res) => {
  try {
    const { estado, nota } = req.body;
    const pedido = await Pedido.findByPk(req.params.id);
    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    // Máquina de estados permitidos según rol
    const transicionesPermitidas = {
      negocio:     { pendiente: ['confirmado', 'rechazado'], confirmado: ['preparando'], preparando: ['listo'] },
      repartidor:  { listo: ['en_camino'], en_camino: ['entregado'] },
      admin:       '*',   // Admin puede hacer cualquier transición
      cliente:     { pendiente: ['cancelado'] },
    };

    const permitidos = transicionesPermitidas[req.usuario.rol];
    if (permitidos !== '*') {
      const desde = pedido.estado;
      if (!permitidos[desde]?.includes(estado)) {
        return res.status(400).json({
          ok: false,
          mensaje: `No puedes cambiar el pedido de "${desde}" a "${estado}".`,
        });
      }
    }

    // Registrar timestamp según el estado
    const timestamps = {
      confirmado: 'confirmado_en',
      en_camino:  'asignado_en',
      entregado:  'entregado_en',
      cancelado:  'cancelado_en',
    };
    if (timestamps[estado]) pedido[timestamps[estado]] = new Date();

    pedido.estado = estado;
    await pedido.save();

    // Notificar a todos los involucrados en tiempo real
    const io = req.app.get('io');
    io.to(`pedido:${pedido.id}`).emit('estado_pedido', {
      pedido_id: pedido.id,
      estado,
      actualizado_en: new Date(),
    });

    res.json({ ok: true, mensaje: `Pedido actualizado a: ${estado}`, data: { pedido } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar el estado.' });
  }
};

// ─── POST /api/pedidos/:id/calificar ─────────────────────
const calificarPedido = async (req, res) => {
  try {
    const { calificacion_repartidor, calificacion_negocio, comentario } = req.body;
    const pedido = await Pedido.findOne({
      where: { id: req.params.id, cliente_id: req.usuario.id, estado: 'entregado' },
    });

    if (!pedido) {
      return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado o aún no entregado.' });
    }
    if (pedido.calificacion_repartidor) {
      return res.status(400).json({ ok: false, mensaje: 'Ya calificaste este pedido.' });
    }

    await pedido.update({ calificacion_repartidor, calificacion_negocio, comentario });

    // TODO: Recalcular promedio del repartidor y negocio

    res.json({ ok: true, mensaje: '¡Gracias por tu calificación! 🌟', data: { pedido } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al calificar el pedido.' });
  }
};

module.exports = { crearPedido, misPedidos, obtenerPedido, actualizarEstado, calificarPedido };
