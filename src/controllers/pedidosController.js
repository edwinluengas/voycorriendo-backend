const { Pedido, Negocio, Repartidor, Usuario, Producto, FondoRepartidor } = require('../models');
const { Op } = require('sequelize');
const { sequelize: dbConn } = require('../config/database');
const { randomInt } = require('crypto');
const { calcularDistanciaKm } = require('../utils/distancia');
const { calcularCostoEnvio, getMaxKm } = require('../utils/precios');
const { PEDIDO_MINIMO, VOYTOKENS } = require('../config/precios');
const { calcularFeeCliente, procesarEntrega } = require('../services/economia.service');
const { consumirTokensFIFO } = require('./tokensController');
const tg = require('../services/telegram.service');
const push = require('../services/notificaciones.service');
const { subirImagen } = require('../services/storage.service');

// Genera número de pedido legible: MND-004823
const generarNumeroPedido = () => {
  const num = randomInt(1000, 899000 + 1000).toString().padStart(6, '0');
  return `MND-${num}`;
};

const generarCodigoEntrega = () => randomInt(1000, 10000).toString();

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
      paga_con = null,
    } = req.body;

    // Express siempre viaja solo — batch_id se ignora para express
    if (tipo_envio === 'express' && req.body.batch_id) {
      return res.status(400).json({ ok: false, mensaje: 'Los pedidos Express viajan solos y no pueden combinarse en rutas.' });
    }

    // 1. Verificar negocio
    const negocio = await Negocio.findByPk(negocio_id);
    if (!negocio || !negocio.activo) {
      return res.status(400).json({ ok: false, mensaje: 'El negocio no está disponible.' });
    }

    // 2. Validar items
    let subtotal = 0;
    let requiereINE = false;
    const itemsDetallados = [];

    for (const item of items) {
      const producto = await Producto.findOne({
        where: { id: item.producto_id, negocio_id, disponible: true },
      });
      if (!producto) {
        return res.status(400).json({ ok: false, mensaje: `El producto "${item.producto_id}" no está disponible.` });
      }
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
        producto_id:    producto.id,
        nombre:         producto.nombre,
        precio_unitario: producto.precio,
        cantidad:       item.cantidad,
        subtotal:       precioItem,
        notas:          item.notas || null,
        opcion_elegida: item.opcion_elegida || null,
        requiere_id:    !!producto.requiere_id,
      });
    }

    if (requiereINE && !ine_foto_url) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Tu pedido incluye productos con restricción de edad. Necesitamos una foto de tu INE.',
      });
    }

    // 3. Calcular distancia y validar cobertura por tipo_envio
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

    const maxKm = await getMaxKm(tipo_envio);
    if (distanciaKm != null && distanciaKm > maxKm) {
      const tipoLabel = tipo_envio === 'express' ? 'Express' : 'Estándar';
      return res.status(400).json({
        ok: false,
        mensaje: `Tu dirección está a ${distanciaKm.toFixed(1)} km. El envío ${tipoLabel} tiene cobertura máxima de ${maxKm} km.`,
      });
    }

    // 4. Validar método de pago
    const metodosValidos = ['efectivo', 'tarjeta', 'mercado_pago', 'transferencia'];
    if (!metodosValidos.includes(metodo_pago)) {
      return res.status(400).json({ ok: false, mensaje: 'Método de pago no válido.' });
    }
    if (metodo_pago === 'transferencia' && negocio.categoria !== 'ahivoy store') {
      return res.status(400).json({
        ok: false,
        mensaje: 'La transferencia SPEI solo está disponible para compras en la VoyCorriendo Store.',
      });
    }

    // 5. Pedido mínimo
    if (subtotal < PEDIDO_MINIMO) {
      return res.status(400).json({
        ok: false,
        mensaje: `El pedido mínimo es de $${PEDIDO_MINIMO} MXN. Tu carrito suma $${subtotal.toFixed(2)} MXN.`,
      });
    }

    // 5. Fee de envío (zone-based desde DB)
    const tarifaResult = await calcularCostoEnvio({ distanciaKm: distanciaKm ?? 1, tipoEnvio: tipo_envio });
    let fee_cliente = tarifaResult.fueraDeCobertura
      ? calcularFeeCliente({ tipoEnvio: tipo_envio })
      : tarifaResult.costo;

    let tokens_canjeados = 0;
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

    // 6. Límite efectivo: productos ≤ $500 (el envío se suma encima)
    if (metodo_pago === 'efectivo' && subtotal > 500) {
      return res.status(400).json({
        ok: false,
        mensaje: `Pagos en efectivo solo para pedidos hasta $500 MXN en productos. Tu subtotal es $${subtotal.toFixed(2)}. Elige tarjeta o Mercado Pago.`,
      });
    }

    // 7. Crear pedido + descontar VoyTokens (atómico)
    const pedido = await dbConn.transaction(async (t) => {
      const nuevoPedido = await Pedido.create({
        numero:           generarNumeroPedido(),
        cliente_id:       req.usuario.id,
        negocio_id,
        items:            itemsDetallados,
        subtotal,
        costo_envio:      fee_cliente,
        total,
        distancia_km:     distanciaKm,
        metodo_pago,
        pago_estado:      'pendiente',
        ciudad:           negocio.ciudad || 'puerto_escondido',
        tipo_envio,
        fee_cliente,
        paga_con:         metodo_pago === 'efectivo' ? (paga_con ? Number(paga_con) : null) : null,
        direccion_entrega,
        latitud_entrega,
        longitud_entrega,
        notas_entrega,
        ine_foto_url:     requiereINE ? ine_foto_url : null,
        estado:           'pendiente',
        codigo_entrega:   generarCodigoEntrega(),
      }, { transaction: t });

      if (tokens_canjeados > 0) {
        await Usuario.decrement('voytokens', {
          by: tokens_canjeados,
          where: { id: req.usuario.id },
          transaction: t,
        });
      }

      return nuevoPedido;
    });

    // 8. Notificaciones al negocio
    // Pagos digitales (tarjeta/MP): el negocio NO recibe notificación hasta que
    // el webhook de MP confirme el pago. Evita que confirmen pedidos sin cobrar.
    const metodoDigital = ['tarjeta', 'mercado_pago'].includes(metodo_pago);
    if (!metodoDigital) {
      const io = req.app.get('io');
      io.to(`negocio:${negocio_id}`).emit('nuevo_pedido', {
        pedido_id: pedido.id,
        numero: pedido.numero,
        total: pedido.total,
        items: itemsDetallados,
        distancia_km: distanciaKm,
      });
      const dueno = await Usuario.findByPk(negocio.usuario_id, { attributes: ['telegram_chat_id', 'token_push'] });
      if (dueno?.telegram_chat_id) {
        tg.alertaNuevoPedido(dueno.telegram_chat_id, pedido).catch((e) => console.warn('[notif] Telegram error:', e.message));
      }
      if (dueno?.token_push) {
        push.notificarNuevoPedido(dueno.token_push, pedido).catch((e) => console.warn('[notif] Push error:', e.message));
      }
    }

    res.status(201).json({
      ok: true,
      mensaje: metodoDigital
        ? '¡Pedido creado! Completa el pago para que el negocio lo reciba.'
        : '¡Pedido creado! Esperando confirmación del negocio.',
      data: { pedido },
    });
  } catch (error) {
    console.error('Error al crear pedido:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al procesar tu pedido.' });
  }
};

// ─── GET /api/pedidos ─────────────────────────────────────
const misPedidos = async (req, res) => {
  try {
    const pedidos = await Pedido.findAll({
      where: { cliente_id: req.usuario.id },
      order: [['creado_en', 'DESC']],
      limit: 20,
      include: [
        { model: Negocio, as: 'negocio', attributes: ['id', 'nombre', 'logo', 'categoria'] },
        {
          model: Repartidor, as: 'repartidor',
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
        {
          model: Negocio, as: 'negocio',
          attributes: ['id', 'nombre', 'logo', 'telefono', 'direccion', 'latitud', 'longitud', 'categoria', 'tipo_entrega', 'usuario_id'],
        },
        {
          model: Repartidor, as: 'repartidor',
          attributes: ['id', 'calificacion_promedio', 'latitud', 'longitud', 'marca_vehiculo', 'color_vehiculo'],
          include: [{ model: Usuario, as: 'usuario', attributes: ['nombre', 'foto_perfil', 'telefono'] }],
        },
        { model: Usuario, as: 'cliente', attributes: ['id', 'nombre', 'telefono', 'foto_perfil'] },
      ],
    });

    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    const esCliente    = pedido.cliente_id === req.usuario.id;
    const esRepartidor = pedido.repartidor?.usuario_id === req.usuario.id;
    const esNegocio    = pedido.negocio?.usuario_id === req.usuario.id;
    const esAdmin      = req.usuario.rol === 'admin';

    if (!esCliente && !esRepartidor && !esNegocio && !esAdmin) {
      return res.status(403).json({ ok: false, mensaje: 'No tienes acceso a este pedido.' });
    }

    // El repartidor no debe ver el código — lo obtiene verbalmente del cliente al entregar
    const pedidoData = pedido.toJSON();
    if (esRepartidor && !esCliente && !esAdmin) {
      delete pedidoData.codigo_entrega;
    }

    res.json({ ok: true, data: { pedido: pedidoData } });
  } catch (error) {
    console.error('Error al obtener pedido:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener el pedido.' });
  }
};

// ─── GET /api/pedidos/negocio/mis-pedidos ────────────────
const pedidosDelNegocio = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) {
      return res.status(404).json({ ok: false, mensaje: 'No tienes un negocio asociado a tu cuenta.' });
    }

    const where = { negocio_id: negocio.id };
    if (req.query.estado) {
      const estados = String(req.query.estado).split(',').map((s) => s.trim());
      where.estado = estados.length === 1 ? estados[0] : estados;
    }

    const pedidos = await Pedido.findAll({
      where,
      order: [['creado_en', 'DESC']],
      limit: 50,
      include: [
        { model: Usuario, as: 'cliente', attributes: ['id', 'nombre', 'telefono', 'foto_perfil'] },
        {
          model: Repartidor, as: 'repartidor',
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
const actualizarEstado = async (req, res) => {
  try {
    const { estado, nota } = req.body;
    const pedido = await Pedido.findByPk(req.params.id, {
      include: [{ model: Negocio, as: 'negocio', attributes: ['id', 'nombre', 'usuario_id'] }],
    });
    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    const rolEfectivo = req.usuario.modo_activo || req.usuario.rol;

    if (rolEfectivo === 'negocio' && pedido.negocio?.usuario_id !== req.usuario.id) {
      return res.status(403).json({ ok: false, mensaje: 'Este pedido no pertenece a tu negocio.' });
    }
    if (rolEfectivo === 'cliente' && pedido.cliente_id !== req.usuario.id) {
      return res.status(403).json({ ok: false, mensaje: 'Este pedido no es tuyo.' });
    }
    if (rolEfectivo === 'repartidor') {
      const repActual = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
      if (pedido.repartidor_id && pedido.repartidor_id !== repActual?.id) {
        return res.status(403).json({ ok: false, mensaje: 'Este pedido no te fue asignado.' });
      }
    }

    const transicionesPermitidas = {
      negocio: {
        pendiente:  ['confirmado', 'rechazado'],
        confirmado: ['preparando'],
        preparando: ['listo'],
        listo:      ['en_envio', 'entregado'],
        en_envio:   ['entregado'],
      },
      repartidor: {
        confirmado: ['preparando'],
        preparando: ['listo'],
        listo:      ['en_camino'],
        en_camino:  ['entregado'],
      },
      admin:   '*',
      cliente: { pendiente: ['cancelado'] },
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

    if (estado === 'entregado' && pedido.estado === 'listo' && rolEfectivo === 'negocio' && pedido.tipo_envio !== 'pickup') {
      return res.status(400).json({ ok: false, mensaje: 'Solo pedidos de recogida en tienda pueden marcarse entregados desde listo.' });
    }

    // ── Bloquear confirmación si el pago digital no fue capturado ──
    if (estado === 'confirmado' && rolEfectivo === 'negocio') {
      const metodoDigital = ['tarjeta', 'mercado_pago'].includes(pedido.metodo_pago);
      if (metodoDigital && pedido.pago_estado !== 'capturado') {
        return res.status(402).json({
          ok: false,
          mensaje: 'El pago con tarjeta aún no ha sido confirmado. Espera la notificación de pago antes de aceptar el pedido.',
          codigo: 'PAGO_PENDIENTE',
        });
      }
    }

    // ── Consumir 1 token al confirmar (FIFO) ───────────────
    if (estado === 'confirmado' && rolEfectivo === 'negocio') {
      try {
        await dbConn.transaction(async (t) => {
          await consumirTokensFIFO(pedido.negocio_id, pedido.id, 1, t);
        });
      } catch (tokenErr) {
        const httpStatus = tokenErr.httpStatus || 402;
        return res.status(httpStatus).json({
          ok: false,
          mensaje: tokenErr.message,
          codigo: 'TOKENS_INSUFICIENTES',
        });
      }
    }

    // Timestamps
    const timestamps = {
      confirmado: 'confirmado_en',
      en_camino:  'asignado_en',
      en_envio:   'enviado_en',
      entregado:  'entregado_en',
      cancelado:  'cancelado_en',
    };
    if (timestamps[estado]) pedido[timestamps[estado]] = new Date();

    if (estado === 'en_envio' && req.body.numero_guia) {
      pedido.numero_guia = req.body.numero_guia;
    }

    // Validar código / foto al entregar (repartidor)
    if (estado === 'entregado' && rolEfectivo === 'repartidor') {
      const { codigo_entrega: codigoProvisto, foto_entrega } = req.body;
      if (foto_entrega) {
        try {
          const ruta = `entregas/${pedido.id}_${Date.now()}.jpg`;
          const url = await subirImagen('documentos-negocios', ruta, foto_entrega, 'image/jpeg');
          pedido.foto_entrega = url;
        } catch (e) {
          return res.status(400).json({ ok: false, mensaje: 'No se pudo procesar la foto. Usa el código de entrega.' });
        }
      } else {
        if (!codigoProvisto) {
          return res.status(400).json({ ok: false, mensaje: 'Ingresa el código de entrega del cliente para confirmar.' });
        }
        if (String(codigoProvisto) !== String(pedido.codigo_entrega)) {
          return res.status(400).json({ ok: false, mensaje: 'Código incorrecto. Pídelo al cliente.' });
        }
      }
    }

    pedido.estado = estado;
    await pedido.save();

    // Al entregar: economía + VoyTokens
    if (estado === 'entregado') {
      if (pedido.repartidor_id) {
        try {
          const repartidor = await Repartidor.findByPk(pedido.repartidor_id);
          if (repartidor) await procesarEntrega({ pedido, repartidor });
        } catch (e) {
          console.error('Error en procesarEntrega:', e.message);
        }
      }
      try {
        const tokensGanados = Math.floor(parseFloat(pedido.subtotal || 0) / 10);
        if (tokensGanados > 0) {
          await Usuario.increment('voytokens', {
            by: tokensGanados,
            where: { id: pedido.cliente_id },
          });
        }
      } catch (e) {
        console.error('Error sumando VoyTokens:', e.message);
      }
      try {
        const negocioEntregado = await Negocio.findByPk(pedido.negocio_id);
        const dueno = negocioEntregado
          ? await Usuario.findByPk(negocioEntregado.usuario_id, { attributes: ['telegram_chat_id'] })
          : null;
        if (dueno?.telegram_chat_id) tg.alertaPedidoEntregado(dueno.telegram_chat_id, pedido).catch(() => {});
      } catch (_) {}
    }

    // Notificaciones en tiempo real
    const io = req.app.get('io');
    const payload = { pedido_id: pedido.id, numero: pedido.numero, estado, actualizado_en: new Date() };
    io.to(`pedido:${pedido.id}`).emit('estado_pedido', payload);
    if (pedido.negocio_id) io.to(`negocio:${pedido.negocio_id}`).emit('estado_pedido', payload);

    try {
      const clientePush = await Usuario.findByPk(pedido.cliente_id, { attributes: ['token_push'] });
      if (clientePush?.token_push) {
        push.notificarEstadoPedido(clientePush.token_push, pedido, estado).catch(() => {});
      }
    } catch (_) {}

    if (estado === 'listo' && pedido.tipo_envio !== 'pickup') {
      try {
        io.to('repartidores_activos').emit('pedido_disponible', {
          pedido_id: pedido.id,
          numero:    pedido.numero,
          ciudad:    pedido.ciudad,
        });
        const repartidoresAprobados = await Repartidor.findAll({
          where: { verificacion_estado: 'aprobado' },
          include: [{ model: Usuario, as: 'usuario', attributes: ['token_push'] }],
        });
        const tokensRep = repartidoresAprobados.map((r) => r.usuario?.token_push).filter(Boolean);
        if (tokensRep.length > 0) {
          push.notificarRepartidoresDisponibles(tokensRep, pedido).catch(() => {});
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
    const { calificacion_repartidor, calificacion_negocio, comentario, propina } = req.body;

    // Validar rangos antes de tocar la DB
    if (calificacion_negocio !== undefined && calificacion_negocio !== null) {
      const cn = Number(calificacion_negocio);
      if (!Number.isInteger(cn) || cn < 1 || cn > 5) {
        return res.status(400).json({ ok: false, mensaje: 'Calificación del negocio debe ser entre 1 y 5.' });
      }
    }
    if (calificacion_repartidor !== undefined && calificacion_repartidor !== null) {
      const cr = Number(calificacion_repartidor);
      if (!Number.isInteger(cr) || cr < 1 || cr > 5) {
        return res.status(400).json({ ok: false, mensaje: 'Calificación del repartidor debe ser entre 1 y 5.' });
      }
    }
    const propinaNum = parseFloat(propina) || 0;
    if (propinaNum < 0 || propinaNum > 1000) {
      return res.status(400).json({ ok: false, mensaje: 'Propina no válida (máximo $1,000 MXN).' });
    }

    const pedido = await Pedido.findOne({
      where: { id: req.params.id, cliente_id: req.usuario.id, estado: 'entregado' },
    });
    if (!pedido) {
      return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado o aún no entregado.' });
    }
    if (pedido.calificacion_negocio !== null) {
      return res.status(400).json({ ok: false, mensaje: 'Ya calificaste este pedido.' });
    }
    await pedido.update({
      calificacion_repartidor: calificacion_repartidor || null,
      calificacion_negocio,
      comentario,
      propina: propinaNum > 0 ? propinaNum : 0,
    });

    // Propina va al fondo del repartidor (transparencia, sin comisión de plataforma)
    if (propinaNum > 0 && pedido.repartidor_id) {
      const [fondo] = await FondoRepartidor.findOrCreate({
        where: { repartidor_id: pedido.repartidor_id },
        defaults: { monto_disponible: 0, monto_reservado: 0 },
      });
      await fondo.increment('monto_disponible', { by: propinaNum });
    }

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

    res.json({ ok: true, mensaje: '¡Gracias por tu calificación!', data: { pedido } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al calificar el pedido.' });
  }
};

// ─── GET /api/pedidos/cotizar ─────────────────────────────
// Query: negocio_id, lat, lng, tipo_envio (opcional, default 'standard')
const cotizarEnvio = async (req, res) => {
  try {
    const { negocio_id, lat, lng, tipo_envio = 'standard' } = req.query;
    if (!negocio_id) return res.status(400).json({ ok: false, mensaje: 'Falta negocio_id.' });

    const negocio = await Negocio.findByPk(negocio_id);
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });

    if (!negocio.latitud || !negocio.longitud || lat == null || lng == null) {
      const tarifa = await calcularCostoEnvio({ distanciaKm: 1, tipoEnvio: tipo_envio });
      return res.json({
        ok: true,
        data: {
          distancia_km: null,
          zona: tarifa.zona,
          costo_envio: tarifa.costo,
          fuera_de_cobertura: false,
          aviso: 'No tenemos tu ubicación exacta; usamos tarifa base.',
        },
      });
    }

    const { km } = await calcularDistanciaKm(
      { lat: Number(negocio.latitud), lng: Number(negocio.longitud) },
      { lat: Number(lat), lng: Number(lng) },
    );
    const distanciaKm = Number(km.toFixed(2));
    const maxKm = await getMaxKm(tipo_envio);

    if (distanciaKm > maxKm) {
      const tipoLabel = tipo_envio === 'express' ? 'Express' : 'Estándar';
      return res.json({
        ok: true,
        data: {
          distancia_km: distanciaKm,
          zona: null,
          costo_envio: 0,
          fuera_de_cobertura: true,
          aviso: `Tu dirección está a ${distanciaKm.toFixed(1)} km. El envío ${tipoLabel} cubre hasta ${maxKm} km.`,
        },
      });
    }

    const tarifa = await calcularCostoEnvio({ distanciaKm, tipoEnvio: tipo_envio });
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
    console.error('[cotizar] error:', error);
    res.status(500).json({ ok: false, mensaje: 'No pudimos calcular la tarifa.' });
  }
};

module.exports = {
  crearPedido, misPedidos, obtenerPedido, actualizarEstado,
  calificarPedido, pedidosDelNegocio, cotizarEnvio,
};
