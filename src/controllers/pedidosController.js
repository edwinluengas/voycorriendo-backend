const { Pedido, Negocio, Repartidor, Usuario, Producto } = require('../models');
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { calcularDistanciaKm } = require('../utils/distancia');
const { MAX_DISTANCE_KM, calcularCostoEnvio } = require('../utils/precios');
const { PEDIDO_MINIMO, VOYTOKENS } = require('../config/precios');
const { calcularFeeCliente, procesarEntrega } = require('../services/economia.service');
const tg = require('../services/telegram.service');
const push = require('../services/notificaciones.service');

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
      items,
      direccion_entrega,
      latitud_entrega,
      longitud_entrega,
      notas_entrega,
      metodo_pago,
      ine_foto_url,
      tipo_envio = 'standard',
      usa_tokens = false,
    } = req.body;

    // 1. Verificar negocio existe y está abierto
    const negocio = await Negocio.findByPk(negocio_id);
    if (!negocio || !negocio.activo) {
      return res.status(400).json({ ok: false, mensaje: 'El negocio no está disponible.' });
    }

    // 2. Validar y calcular precios de los items
    let subtotal = 0;
    let requiereINE = false;
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

      // Si el producto tiene opciones requeridas, validar que el cliente eligió una
      if (producto.opciones?.requerida && !item.opcion_elegida) {
        return res.status(400).json({
          ok: false,
          mensaje: `El producto "${producto.nombre}" requiere que elijas una opción (${producto.opciones?.titulo || 'opción'}).`,
        });
      }

      if (producto.requiere_id) requiereINE = true;

      const precioItem = parseFloat(producto.precio) * item.cantidad;
      subtotal += precioItem;
      itemsDetallados.push({
        producto_id: producto.id,
        nombre: producto.nombre,
        precio_unitario: producto.precio,
        cantidad: item.cantidad,
        subtotal: precioItem,
        notas: item.notas || null,
        opcion_elegida: item.opcion_elegida || null,
        requiere_id: !!producto.requiere_id,
      });
    }

    // 2b. Si algún producto requiere ID, exigir foto del INE
    if (requiereINE && !ine_foto_url) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Tu pedido incluye productos con restricción de edad (alcohol o cigarros). Necesitamos una foto de tu INE para poder entregarlos.',
      });
    }

    // 3. Calcular distancia y validar cobertura
    let distanciaKm = null;

    const origen  = negocio.latitud && negocio.longitud
      ? { lat: Number(negocio.latitud), lng: Number(negocio.longitud) }
      : null;
    const destino = latitud_entrega && longitud_entrega
      ? { lat: Number(latitud_entrega), lng: Number(longitud_entrega) }
      : null;

    if (origen && destino) {
      try {
        const { km } = await calcularDistanciaKm(origen, destino);
        distanciaKm = Number(km.toFixed(2));
      } catch (e) {
        console.warn('No se pudo calcular distancia:', e.message);
      }
    }

    if (distanciaKm != null && distanciaKm > MAX_DISTANCE_KM) {
      return res.status(400).json({
        ok: false,
        mensaje: `Tu dirección está a ${distanciaKm.toFixed(1)} km. Solo entregamos hasta ${MAX_DISTANCE_KM} km del negocio.`,
      });
    }

    // 4. Validar pedido mínimo ($100 en productos)
    if (subtotal < PEDIDO_MINIMO) {
      return res.status(400).json({
        ok: false,
        mensaje: `El pedido mínimo es de $${PEDIDO_MINIMO} MXN en productos. Tu carrito suma $${subtotal.toFixed(2)} MXN.`,
      });
    }

    // 5. Calcular fee de envío (modelo flat-rate)
    let fee_cliente = calcularFeeCliente({ tipoEnvio: tipo_envio });
    let tokens_canjeados = 0;

    // 5b. Canjear VoyTokens → envío gratis
    if (usa_tokens) {
      const clienteDB = await Usuario.findByPk(req.usuario.id, { attributes: ['voytokens'] });
      const tokensActuales = clienteDB?.voytokens || 0;
      if (tokensActuales < VOYTOKENS.ENVIO_GRATIS) {
        return res.status(400).json({
          ok: false,
          mensaje: `Necesitas ${VOYTOKENS.ENVIO_GRATIS} VoyTokens para envío gratis. Tienes ${tokensActuales}.`,
        });
      }
      fee_cliente = 0;
      tokens_canjeados = VOYTOKENS.ENVIO_GRATIS;
    }

    const total = subtotal + fee_cliente;

    // 6. Validar límite de efectivo
    if (metodo_pago === 'efectivo' && total > 500) {
      return res.status(400).json({
        ok: false,
        mensaje: `Pagos en efectivo hasta $500 MXN. Tu pedido es $${total.toFixed(2)}. Elige tarjeta, transferencia o Mercado Pago.`,
      });
    }

    // 7. Crear el pedido
    const pedido = await Pedido.create({
      numero: generarNumeroPedido(),
      cliente_id: req.usuario.id,
      negocio_id,
      items: itemsDetallados,
      subtotal,
      costo_envio: fee_cliente,
      total,
      distancia_km: distanciaKm,
      metodo_pago,
      pago_estado: 'pendiente',
      ciudad: negocio.ciudad || 'puerto_escondido',
      tipo_envio,
      fee_cliente,
      direccion_entrega,
      latitud_entrega,
      longitud_entrega,
      notas_entrega,
      ine_foto_url: requiereINE ? ine_foto_url : null,
      estado: 'pendiente',
    });

    // 7b. Descontar VoyTokens canjeados
    if (tokens_canjeados > 0) {
      await Usuario.decrement('voytokens', {
        by: tokens_canjeados,
        where: { id: req.usuario.id },
      });
      console.log(`[tokens] -${tokens_canjeados} VoyTokens (envío gratis) → cliente ${req.usuario.id}`);
    }

    // 8. Notificar al negocio vía Socket.io + Telegram + Push
    const io = req.app.get('io');
    io.to(`negocio:${negocio_id}`).emit('nuevo_pedido', {
      pedido_id: pedido.id,
      numero: pedido.numero,
      total: pedido.total,
      items: itemsDetallados,
      distancia_km: distanciaKm,
    });
    const dueno = await Usuario.findByPk(negocio.usuario_id, { attributes: ['telegram_chat_id', 'token_push'] });
    console.log(`[notif] dueño negocio ${negocio.usuario_id}: token_push=${dueno?.token_push ? 'OK' : 'NULL'}, tg=${dueno?.telegram_chat_id ? 'OK' : 'NULL'}`);
    if (dueno?.telegram_chat_id) {
      tg.alertaNuevoPedido(dueno.telegram_chat_id, pedido).catch((e) => console.warn('[notif] Telegram negocio error:', e.message));
    }
    if (dueno?.token_push) {
      push.notificarNuevoPedido(dueno.token_push, pedido).catch((e) => console.warn('[notif] Push negocio error:', e.message));
    }
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
        { model: Negocio, as: 'negocio', attributes: ['id', 'nombre', 'logo', 'telefono', 'direccion', 'latitud', 'longitud', 'categoria', 'tipo_entrega', 'usuario_id'] },
        { model: Repartidor, as: 'repartidor',
          attributes: ['id', 'calificacion_promedio', 'latitud', 'longitud', 'marca_vehiculo', 'color_vehiculo'],
          include: [{ model: Usuario, as: 'usuario', attributes: ['nombre', 'foto_perfil', 'telefono'] }],
        },
        { model: Usuario, as: 'cliente', attributes: ['id', 'nombre', 'telefono', 'foto_perfil'] },
      ],
    });

    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    // Solo el cliente dueño, el negocio dueño del pedido o el repartidor pueden verlo
    const esCliente    = pedido.cliente_id === req.usuario.id;
    const esRepartidor = pedido.repartidor?.usuario_id === req.usuario.id;
    const esNegocio    = req.usuario.rol === 'negocio' && pedido.negocio?.usuario_id === req.usuario.id;
    const esAdmin      = req.usuario.rol === 'admin';

    if (!esCliente && !esRepartidor && !esNegocio && !esAdmin) {
      return res.status(403).json({ ok: false, mensaje: 'No tienes acceso a este pedido.' });
    }

    res.json({ ok: true, data: { pedido } });
  } catch (error) {
    console.error('Error al obtener pedido:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener el pedido.' });
  }
};

// ─── GET /api/pedidos/negocio/mis-pedidos ────────────────
// Lista todos los pedidos del negocio cuyo dueño es el usuario autenticado.
// Permite filtrar por estado con ?estado=pendiente (o varios: ?estado=pendiente,confirmado).
const pedidosDelNegocio = async (req, res) => {
  try {
    // 1. Obtener el negocio del usuario autenticado
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) {
      return res.status(404).json({
        ok: false,
        mensaje: 'No tienes un negocio asociado a tu cuenta.',
      });
    }

    // 2. Construir filtro
    const where = { negocio_id: negocio.id };
    if (req.query.estado) {
      const estados = String(req.query.estado).split(',').map((s) => s.trim());
      where.estado = estados.length === 1 ? estados[0] : estados;
    }

    // 3. Cargar pedidos (últimos 50)
    const pedidos = await Pedido.findAll({
      where,
      order: [['creado_en', 'DESC']],
      limit: 50,
      include: [
        { model: Usuario, as: 'cliente', attributes: ['id', 'nombre', 'telefono', 'foto_perfil'] },
        { model: Repartidor, as: 'repartidor',
          include: [{ model: Usuario, as: 'usuario', attributes: ['nombre', 'telefono'] }],
        },
      ],
    });

    res.json({ ok: true, data: { negocio: { id: negocio.id, nombre: negocio.nombre }, pedidos } });
  } catch (error) {
    console.error('Error al listar pedidos del negocio:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener los pedidos del negocio.' });
  }
};

// ─── PATCH /api/pedidos/:id/estado ───────────────────────
// Negocio confirma / rechaza. Repartidor actualiza a en_camino / entregado.
const actualizarEstado = async (req, res) => {
  try {
    const { estado, nota } = req.body;
    const pedido = await Pedido.findByPk(req.params.id, {
      include: [{ model: Negocio, as: 'negocio', attributes: ['id', 'usuario_id'] }],
    });
    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    // Rol efectivo: modo_activo tiene prioridad sobre rol (sistema multi-rol)
    const rolEfectivo = req.usuario.modo_activo || req.usuario.rol;

    // Verificar ownership según rol efectivo
    if (rolEfectivo === 'negocio' && pedido.negocio?.usuario_id !== req.usuario.id) {
      return res.status(403).json({ ok: false, mensaje: 'Este pedido no pertenece a tu negocio.' });
    }
    if (rolEfectivo === 'cliente' && pedido.cliente_id !== req.usuario.id) {
      return res.status(403).json({ ok: false, mensaje: 'Este pedido no es tuyo.' });
    }

    // Máquina de estados permitidos según rol efectivo
    const transicionesPermitidas = {
      negocio:    {
        pendiente:  ['confirmado', 'rechazado'],
        confirmado: ['preparando'],
        preparando: ['listo'],
        listo:      ['en_envio'],      // paquetería: negocio marca como enviado
        en_envio:   ['entregado'],     // paquetería: negocio confirma recepción
      },
      repartidor:  { en_camino: ['entregado'] },
      admin:       '*',
      cliente:     { pendiente: ['cancelado'] },
    };

    const permitidos = transicionesPermitidas[rolEfectivo];
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
      en_envio:   'enviado_en',
      entregado:  'entregado_en',
      cancelado:  'cancelado_en',
    };
    if (timestamps[estado]) pedido[timestamps[estado]] = new Date();

    // Guardar número de guía al marcar en_envio
    if (estado === 'en_envio' && req.body.numero_guia) {
      pedido.numero_guia = req.body.numero_guia;
    }

    pedido.estado = estado;
    await pedido.save();

    // Al entregar: registrar economía flat + sumar VoyTokens al cliente
    if (estado === 'entregado') {
      // Pago al repartidor (log flat-rate)
      if (pedido.repartidor_id) {
        try {
          const repartidor = await Repartidor.findByPk(pedido.repartidor_id);
          if (repartidor) await procesarEntrega({ pedido, repartidor });
        } catch (e) {
          console.error('Error en procesarEntrega:', e.message);
        }
      }
      // VoyTokens: 1 token por cada $10 en productos
      try {
        const tokensGanados = Math.floor(parseFloat(pedido.subtotal || 0) / 10);
        if (tokensGanados > 0) {
          await Usuario.increment('voytokens', {
            by: tokensGanados,
            where: { id: pedido.cliente_id },
          });
          console.log(`[tokens] +${tokensGanados} VoyTokens → cliente ${pedido.cliente_id}`);
        }
      } catch (e) {
        console.error('Error sumando VoyTokens:', e.message);
      }
      // Alertas Telegram: negocio y admin
      try {
        const negocioEntregado = await Negocio.findByPk(pedido.negocio_id);
        const dueno = negocioEntregado
          ? await Usuario.findByPk(negocioEntregado.usuario_id, { attributes: ['telegram_chat_id'] })
          : null;
        if (dueno?.telegram_chat_id) tg.alertaPedidoEntregado(dueno.telegram_chat_id, pedido).catch(() => {});
      } catch (_) {}
    }

    // Notificar a todos los involucrados en tiempo real
    const io = req.app.get('io');
    const payloadEstado = {
      pedido_id: pedido.id,
      numero: pedido.numero,
      estado,
      actualizado_en: new Date(),
    };
    io.to(`pedido:${pedido.id}`).emit('estado_pedido', payloadEstado);
    if (pedido.negocio_id) {
      io.to(`negocio:${pedido.negocio_id}`).emit('estado_pedido', payloadEstado);
    }
    // Push al cliente cuando cambia el estado de su pedido
    try {
      const clientePush = await Usuario.findByPk(pedido.cliente_id, { attributes: ['token_push'] });
      if (clientePush?.token_push) {
        push.notificarEstadoPedido(clientePush.token_push, pedido, estado).catch(() => {});
      }
    } catch (_) {}

    // Cuando el pedido está listo: notificar a todos los repartidores aprobados (como Uber Eats)
    if (estado === 'listo') {
      try {
        const repartidoresAprobados = await Repartidor.findAll({
          where: { verificacion_estado: 'aprobado' },
          include: [{ model: Usuario, as: 'usuario', attributes: ['token_push'] }],
        });
        const tokensRepartidores = repartidoresAprobados
          .map((r) => r.usuario?.token_push)
          .filter(Boolean);
        console.log(`[notif] pedido listo → repartidores aprobados: ${repartidoresAprobados.length}, con token: ${tokensRepartidores.length}`);
        if (tokensRepartidores.length > 0) {
          push.notificarRepartidoresDisponibles(tokensRepartidores, pedido).catch((e) => console.warn('[notif] Push repartidores error:', e.message));
        }
      } catch (e) {
        console.warn('[notif] Error notificando repartidores en listo:', e.message);
      }
    }

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
    if (pedido.calificacion_negocio !== null) {
      return res.status(400).json({ ok: false, mensaje: 'Ya calificaste este pedido.' });
    }

    await pedido.update({ calificacion_repartidor: calificacion_repartidor || null, calificacion_negocio, comentario });

    // Recalcular promedio del negocio
    if (calificacion_negocio) {
      const negocio = await Negocio.findByPk(pedido.negocio_id);
      if (negocio) {
        const califs = await Pedido.findAll({
          where: { negocio_id: pedido.negocio_id, calificacion_negocio: { [Op.not]: null } },
          attributes: ['calificacion_negocio'],
        });
        const suma = califs.reduce((acc, p) => acc + p.calificacion_negocio, 0);
        await negocio.update({
          calificacion_promedio: (suma / califs.length).toFixed(2),
          total_pedidos: negocio.total_pedidos + 1,
        });
      }
    }

    // Recalcular promedio del repartidor si aplica
    if (calificacion_repartidor && pedido.repartidor_id) {
      const repartidor = await Repartidor.findByPk(pedido.repartidor_id);
      if (repartidor) {
        const califsRep = await Pedido.findAll({
          where: { repartidor_id: pedido.repartidor_id, calificacion_repartidor: { [Op.not]: null } },
          attributes: ['calificacion_repartidor'],
        });
        const sumaRep = califsRep.reduce((acc, p) => acc + p.calificacion_repartidor, 0);
        await repartidor.update({ calificacion_promedio: (sumaRep / califsRep.length).toFixed(2) });
      }
    }

    res.json({ ok: true, mensaje: '¡Gracias por tu calificación! 🌟', data: { pedido } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al calificar el pedido.' });
  }
};

// ─── GET /api/pedidos/cotizar?negocio_id=&lat=&lng= ───────
// Devuelve la tarifa de envío y zona ANTES de crear el pedido,
// para que el cliente la vea en PagoScreen sin sorpresas.
const cotizarEnvio = async (req, res) => {
  try {
    const { negocio_id, lat, lng } = req.query;
    console.log('[cotizar] negocio_id:', negocio_id, 'lat:', lat, 'lng:', lng);

    if (!negocio_id) return res.status(400).json({ ok: false, mensaje: 'Falta negocio_id.' });

    const negocio = await Negocio.findByPk(negocio_id);
    console.log('[cotizar] negocio:', negocio ? `lat=${negocio.latitud} lng=${negocio.longitud}` : 'null');
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });

    if (!negocio.latitud || !negocio.longitud || lat == null || lng == null) {
      // Sin coordenadas → estimamos zona A
      console.log('[cotizar] sin coords, tarifa default');
      const tarifa = calcularCostoEnvio({ distanciaKm: 1 });
      return res.json({
        ok: true,
        data: {
          distancia_km: null,
          zona: tarifa.zona,
          costo_envio: tarifa.costo,
          fuera_de_cobertura: false,
          desglose: tarifa.desglose,
          aviso: 'No tenemos tu ubicación exacta; usamos tarifa de zona A.',
        },
      });
    }

    console.log('[cotizar] calculando distancia...');
    const { km } = await calcularDistanciaKm(
      { lat: Number(negocio.latitud), lng: Number(negocio.longitud) },
      { lat: Number(lat), lng: Number(lng) },
    );
    console.log('[cotizar] km:', km);
    const distanciaKm = Number(km.toFixed(2));

    if (distanciaKm > MAX_DISTANCE_KM) {
      return res.json({
        ok: true,
        data: {
          distancia_km: distanciaKm,
          zona: null,
          costo_envio: 0,
          fuera_de_cobertura: true,
          aviso: `Tu dirección está a ${distanciaKm.toFixed(1)} km. Solo entregamos hasta ${MAX_DISTANCE_KM} km.`,
        },
      });
    }

    const tarifa = calcularCostoEnvio({ distanciaKm });
    console.log('[cotizar] tarifa:', tarifa.zona, tarifa.costo);
    res.json({
      ok: true,
      data: {
        distancia_km: distanciaKm,
        zona: tarifa.zona,
        costo_envio: tarifa.costo,
        fuera_de_cobertura: false,
        desglose: tarifa.desglose,
      },
    });
  } catch (error) {
    console.error('[cotizar] CATCH tipo:', Object.prototype.toString.call(error));
    console.error('[cotizar] CATCH:', error);
    const _debug = error instanceof Error
      ? `${error.constructor.name}: ${error.message}`
      : String(error);
    res.status(500).json({ ok: false, mensaje: 'No pudimos calcular la tarifa [v3].', _debug });
  }
};

module.exports = { crearPedido, misPedidos, obtenerPedido, actualizarEstado, calificarPedido, pedidosDelNegocio, cotizarEnvio };
