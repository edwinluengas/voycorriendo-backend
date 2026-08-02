const { Pedido, Negocio, Repartidor, Usuario, Producto, FondoRepartidor, DeliveryBatch } = require('../models');
const { Op } = require('sequelize');
const { sequelize: dbConn } = require('../config/database');
const { randomInt } = require('crypto');
const { calcularDistanciaKm } = require('../utils/distancia');
const { CIUDAD_DEFAULT } = require('../config/ciudades');
const { rutaPorCalles } = require('../services/routing.service');
const { obtenerUrlFirmada } = require('../services/storage.service');
const { calcularCostoEnvio, getMaxKm } = require('../utils/precios');
const {
  PEDIDO_MINIMO, CALIFICACIONES_MIN_PARA_BAJA, CALIFICACION_MIN_PROMEDIO, CLIENTES_DISTINTOS_MIN_PARA_BAJA,
  LIMITE_EFECTIVO, metodosPagoActivos, metodoPagoActivo,
} = require('../config/precios');
const { calcularFeeCliente, procesarEntrega } = require('../services/economia.service');
const pagosService = require('../services/pagos.service');
const creditosService = require('../services/creditos.service');
const tg = require('../services/telegram.service');
const eventos = require('../services/eventos.service');
const push = require('../services/notificaciones.service');
const { subirImagen } = require('../services/storage.service');
const { bloquearRepartidorPermanente } = require('../services/seguridadCuentas.service');
const { hayRepartidoresParaEnvio, mensajeSoloPickup } = require('../services/disponibilidad.service');

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const safeExt = (mime) => MIME_EXT[(mime || '').toLowerCase()] || 'jpg';

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
      paga_con = null,
      usar_credito = false,
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
    if (negocio.bloqueado_por_deuda) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Este negocio tiene pedidos suspendidos temporalmente. Intenta más tarde o elige otro restaurante.',
      });
    }
    // Cubre bloqueos que NO son por deuda (dirección duplicada/vetada,
    // bloqueo manual de admin) — bloqueado_por_deuda por sí solo no los
    // detectaba, permitiendo crear pedidos vía deep link/historial/favoritos
    // a un negocio que ya no debería operar.
    if (['suspendido', 'bloqueado'].includes(negocio.estado_cuenta)) {
      return res.status(400).json({ ok: false, mensaje: 'Este negocio no está disponible.' });
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
      const cantidad = Number(item.cantidad);
      if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 100) {
        return res.status(400).json({
          ok: false,
          mensaje: `Cantidad inválida para "${producto.nombre}". Debe ser entre 1 y 100.`,
        });
      }
      const precioItem = parseFloat(producto.precio) * cantidad;
      subtotal += precioItem;
      itemsDetallados.push({
        producto_id:    producto.id,
        nombre:         producto.nombre,
        precio_unitario: producto.precio,
        cantidad,
        subtotal:       precioItem,
        notas:          item.notas || null,
        opcion_elegida: item.opcion_elegida || null,
        requiere_id:    !!producto.requiere_id,
      });
    }

    if (requiereINE) {
      const SUPABASE_HOST = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname : null;
      const ineValida = ine_foto_url && SUPABASE_HOST && ine_foto_url.includes(SUPABASE_HOST) && ine_foto_url.includes('/storage/v1/object/');
      if (!ineValida) {
        return res.status(400).json({
          ok: false,
          mensaje: 'Tu pedido incluye productos con restricción de edad. Sube tu INE desde la app antes de continuar.',
        });
      }
    }

    // 2.5. ¿Hay quién lo entregue? Si nadie está en línea con cupo, el pedido
    // a domicilio se quedaría en 'listo' hasta que el job de timeout lo
    // cancele — el negocio cocinando para nada y el cliente esperando. En ese
    // caso solo se ofrece pickup, y el mensaje se enmarca como beneficio
    // (ahorras el envío) en vez de "no tenemos repartidores".
    if (tipo_envio !== 'pickup') {
      const disponibilidad = await hayRepartidoresParaEnvio(negocio.ciudad || CIUDAD_DEFAULT);
      if (!disponibilidad.disponible) {
        return res.status(409).json({
          ok: false,
          mensaje: mensajeSoloPickup(subtotal),
          codigo: 'SOLO_PICKUP',
          solo_pickup: true,
          ahorro_envio: calcularFeeCliente({ tipoEnvio: tipo_envio }),
        });
      }
    }

    // 3. Calcular distancia y validar cobertura por tipo_envio
    // IMPORTANTE: si no podemos determinar la distancia (falta ubicación del
    // negocio o del cliente, o falla el cálculo), el pedido se RECHAZA — antes
    // se dejaba pasar sin límite de cobertura, permitiendo pedidos a cualquier
    // distancia si el negocio no tenía latitud/longitud configuradas.
    let distanciaKm = null;
    if (tipo_envio !== 'pickup') {
      if (!negocio.latitud || !negocio.longitud) {
        return res.status(400).json({
          ok: false,
          mensaje: 'Este negocio aún no tiene su ubicación configurada y no puede recibir pedidos a domicilio por ahora.',
        });
      }
      if (!latitud_entrega || !longitud_entrega) {
        return res.status(400).json({
          ok: false,
          mensaje: 'Necesitamos tu ubicación para calcular la cobertura de entrega. Activa el GPS y detecta tu ubicación antes de continuar.',
        });
      }

      const origen  = { lat: Number(negocio.latitud), lng: Number(negocio.longitud) };
      const destino = { lat: Number(latitud_entrega), lng: Number(longitud_entrega) };

      try {
        const { km } = await calcularDistanciaKm(origen, destino);
        distanciaKm = Number(km.toFixed(2));
      } catch (e) {
        console.error('No se pudo calcular distancia:', e.message);
        return res.status(503).json({
          ok: false,
          mensaje: 'No pudimos calcular la distancia de entrega. Intenta de nuevo en unos segundos.',
        });
      }

      const maxKm = await getMaxKm(tipo_envio);
      if (distanciaKm > maxKm) {
        const tipoLabel = tipo_envio === 'express' ? 'Express' : 'Estándar';
        return res.status(400).json({
          ok: false,
          mensaje: `Tu dirección está a ${distanciaKm.toFixed(1)} km. El envío ${tipoLabel} tiene cobertura máxima de ${maxKm} km.`,
        });
      }
    }

    // 4. Validar método de pago
    const metodosValidos = ['efectivo', 'tarjeta', 'mercado_pago', 'transferencia'];
    if (!metodosValidos.includes(metodo_pago)) {
      return res.status(400).json({ ok: false, mensaje: 'Método de pago no válido.' });
    }
    // Métodos DESACTIVADOS temporalmente (fase de prueba real: solo efectivo).
    // El candado va aquí, en el servidor: una app vieja o alguien llamando la
    // API directo no debe poder colar un pedido con un método apagado.
    if (!metodoPagoActivo(metodo_pago)) {
      return res.status(400).json({
        ok: false,
        mensaje: metodo_pago === 'efectivo'
          ? 'El pago en efectivo no está disponible por ahora.'
          : 'Por ahora solo aceptamos pago en EFECTIVO al recibir tu pedido. El pago con tarjeta estará disponible muy pronto.',
        codigo: 'METODO_PAGO_DESACTIVADO',
        metodos_activos: metodosPagoActivos(),
      });
    }
    if (metodo_pago === 'transferencia' && negocio.categoria !== 'ahivoy store') {
      return res.status(400).json({
        ok: false,
        mensaje: 'La transferencia SPEI solo está disponible para compras en Voy Store®.',
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

    // Propina elegida en el CHECKOUT (solo pagos con tarjeta): se suma al
    // total para que el cargo real a la tarjeta la incluya — antes se
    // elegía al calificar y nunca se cobraba (la pagaba la plataforma).
    // En efectivo se da en mano al entregar, no entra al total.
    const propinaNum = Number(req.body.propina) || 0;
    const propina = (metodo_pago !== 'efectivo' && Number.isFinite(propinaNum) && propinaNum > 0 && propinaNum <= 1000)
      ? Math.round(propinaNum * 100) / 100 : 0;

    const total = subtotal + fee_cliente + propina;

    // 6. Límite de efectivo: se mide sobre el subtotal de PRODUCTOS (el envío
    // se suma encima). El monto viene de config/precios.js — antes estaba
    // hardcodeado aquí Y como env var en pagos.service, así que cambiarlo en
    // un lado dejaba el otro desalineado.
    if (metodo_pago === 'efectivo' && subtotal > LIMITE_EFECTIVO) {
      const alternativas = metodosPagoActivos().filter((m) => m !== 'efectivo');
      return res.status(400).json({
        ok: false,
        mensaje: `Pagos en efectivo solo para pedidos hasta $${LIMITE_EFECTIVO} MXN en productos. Tu subtotal es $${subtotal.toFixed(2)}.`
          + (alternativas.length ? ' Elige otro método de pago.' : ' Quita algo del carrito para continuar.'),
        codigo: 'LIMITE_EFECTIVO',
        limite: LIMITE_EFECTIVO,
      });
    }

    // 6.5. Libera de inmediato cualquier crédito de ESTE cliente que haya
    // quedado atrapado en un pedido con tarjeta abandonado (nunca se
    // intentó el cobro, o la tarjeta fue rechazada) — así el crédito
    // disponible que se calcula abajo ya refleja la realidad, sin que el
    // cliente tenga que esperar al barrido de pedidoTimeout.job.js (bug
    // real 2026-07-25, cuenta 5545074460: crédito "desaparecido" al querer
    // usarlo en un segundo pedido inmediatamente después de abandonar el
    // primero).
    if (usar_credito) {
      try {
        await creditosService.liberarCreditoAtrapadoDeUsuario(req.usuario.id);
      } catch (e) {
        console.error('[credito] Error liberando crédito atrapado antes de crear pedido:', e.message);
      }
    }

    // 7. Crear pedido — el consumo de crédito vive DENTRO de la misma
    // transacción que crea el pedido: si Pedido.create() falla por lo que
    // sea después de descontar el crédito (numero duplicado, error de DB),
    // TODO se revierte junto, incluido el crédito — sin esto, un cliente
    // podía perder su crédito sin recibir ningún pedido a cambio (bug real
    // detectado 2026-07-24 antes de desplegar, ver consumirCredito).
    const pedido = await dbConn.transaction(async (t) => {
      // Aplica a CUALQUIER método de pago — en efectivo, registrarPagoEfectivo
      // ya compara el monto recibido contra el NETO (total - credito_aplicado),
      // así que el repartidor cobra en mano solo lo que el crédito no cubrió.
      let creditoAplicado = 0;
      if (usar_credito) {
        creditoAplicado = await creditosService.consumirCredito({ usuarioId: req.usuario.id, montoSolicitado: total, transaction: t });
      }
      const totalNeto = Math.round((total - creditoAplicado) * 100) / 100;
      // Cubierto 100% por crédito: no hay nada que cobrar a ningún medio de
      // pago — el pedido queda pagado desde ya, sin pasar por MP ni efectivo.
      const pagadoTotalConCredito = totalNeto <= 0;

      const nuevoPedido = await Pedido.create({
        numero:           generarNumeroPedido(),
        cliente_id:       req.usuario.id,
        negocio_id,
        items:            itemsDetallados,
        subtotal,
        costo_envio:      fee_cliente,
        total,
        propina,
        credito_aplicado: creditoAplicado,
        distancia_km:     distanciaKm,
        metodo_pago,
        pago_estado:      pagadoTotalConCredito ? 'capturado' : 'pendiente',
        pago_referencia:  pagadoTotalConCredito ? `CREDITO-${Date.now()}` : null,
        ciudad:           negocio.ciudad || CIUDAD_DEFAULT,
        tipo_envio,
        fee_cliente,
        paga_con:         metodo_pago === 'efectivo' ? (() => {
          const pc = Number(paga_con);
          return (!isNaN(pc) && pc >= totalNeto && pc <= 10000) ? pc : null;
        })() : null,
        // PICKUP: el cliente pasa al negocio, así que la "dirección de
        // entrega" es la del propio negocio (el cliente no escribe ninguna).
        // Guardarla así deja el ticket y el historial legibles.
        direccion_entrega: tipo_envio === 'pickup'
          ? `Recoge en tienda — ${[negocio.nombre, negocio.direccion, negocio.colonia].filter(Boolean).join(', ')}`
          : direccion_entrega,
        latitud_entrega,
        longitud_entrega,
        notas_entrega,
        ine_foto_url:     requiereINE ? ine_foto_url : null,
        estado:           'pendiente',
        codigo_entrega:   generarCodigoEntrega(),
      }, { transaction: t });

      return nuevoPedido;
    });

    // 8. Notificaciones al negocio
    // Pagos digitales (tarjeta/MP/transferencia): el negocio NO recibe
    // notificación hasta que el pago esté confirmado (webhook de MP, o un
    // admin verificando la transferencia SPEI). Evita que confirmen pedidos
    // sin cobrar.
    const metodoDigital = ['tarjeta', 'mercado_pago', 'transferencia'].includes(metodo_pago);
    if (!metodoDigital) {
      const io = req.app.get('io');
      io.to(`negocio:${negocio_id}`).emit('nuevo_pedido', {
        pedido_id: pedido.id,
        numero: pedido.numero,
        total: pedido.total,
        items: itemsDetallados,
        distancia_km: distanciaKm,
      });
      // Bitacora en vivo para el dueno de la plataforma (no es el aviso al
      // negocio, que va aparte): enterarse de que entro un pedido sin
      // tener que abrir la base.
      eventos.pedidoCreado(pedido, negocio);
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
          // Solo lo que la UI de la lista usa. Antes se traía TODA la fila
          // de Repartidor sin filtro — incluía clabe_bancaria (la fila se
          // desencripta sola vía getter de Sequelize al serializar a JSON),
          // fotos de INE/licencia, notas de verificación/moderación y la
          // ubicación GPS, expuestos a cualquier cliente por cada pedido de
          // su historial para siempre. Hallazgo de auditoría 2026-07-24.
          model: Repartidor, as: 'repartidor',
          attributes: ['id', 'calificacion_promedio', 'marca_vehiculo', 'color_vehiculo'],
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
          // usuario_id es obligatorio aquí — es el campo que usa esRepartidor
          // abajo. Sin él en `attributes`, Sequelize no lo carga (no es la PK
          // ni participa del JOIN Pedido↔Repartidor) y esRepartidor siempre
          // da false: el repartidor asignado no podía ver el detalle de su
          // propio pedido (403 permanente). Bug real confirmado con un
          // pedido de prueba end-to-end, 2026-07-24.
          model: Repartidor, as: 'repartidor',
          attributes: ['id', 'usuario_id', 'calificacion_promedio', 'latitud', 'longitud', 'marca_vehiculo', 'color_vehiculo'],
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

    // El código solo lo ve el CLIENTE — el repartidor lo recibe verbalmente, el negocio no lo necesita
    const pedidoData = pedido.toJSON();

    // La foto del INE vive en un bucket PRIVADO desde 2026-07-31, así que su
    // URL directa ya no abre: hay que firmarla. El negocio la necesita para
    // verificar la edad al entregar alcohol, y sin esto solo veía un hueco.
    // Se firma para quien tiene por qué verla y se omite para el resto.
    if (pedidoData.ine_foto_url) {
      if (esNegocio || esAdmin || esCliente) {
        const { BUCKET_PRIVADO_CLIENTES } = require('../config/buckets');
        pedidoData.ine_foto_url =
          (await obtenerUrlFirmada(BUCKET_PRIVADO_CLIENTES, pedidoData.ine_foto_url)) || null;
      } else {
        delete pedidoData.ine_foto_url;   // el repartidor no la necesita
      }
    }
    if (!esCliente && !esAdmin) {
      delete pedidoData.codigo_entrega;
    }

    // Ubicación GPS del repartidor: antes se exponía SIEMPRE, a cualquier
    // parte con acceso al pedido, sin importar el estado — incluyendo
    // pedidos ya entregados hace semanas. Con el mapa de seguimiento en
    // vivo (2026-07-24) ese descuido pasa de un campo silencioso a una
    // ubicación dibujada en un mapa, mucho más explotable. Ahora solo se
    // expone durante la ventana en que cada parte realmente necesita
    // verla: el negocio mientras viene a recoger ('listo'), el cliente
    // mientras viene a entregar ('en_camino'). El repartidor siempre ve la
    // suya propia; admin sin restricción (soporte).
    if (pedidoData.repartidor && !esRepartidor && !esAdmin) {
      // Negocio: mientras el repartidor va por el pedido — asignado pero
      // aún sin marcar `recogido_en` (ver marcarRecogido en
      // repartidoresController; `estado` salta a 'en_camino' desde el
      // instante mismo de aceptar, así que NO sirve para distinguir esta
      // ventana). Cliente: mientras el repartidor va en camino a entregar.
      const esTerminal = ['entregado', 'cancelado', 'rechazado'].includes(pedidoData.estado);
      const ventanaAbierta =
        (esNegocio && !pedidoData.recogido_en && !esTerminal) ||
        (esCliente && pedidoData.estado === 'en_camino');
      if (!ventanaAbierta) {
        delete pedidoData.repartidor.latitud;
        delete pedidoData.repartidor.longitud;
      }
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

    const ESTADOS_VALIDOS = ['pendiente', 'confirmado', 'preparando', 'listo', 'en_camino', 'en_envio', 'entregado', 'rechazado', 'cancelado'];
    const where = { negocio_id: negocio.id };
    if (req.query.estado) {
      const estados = String(req.query.estado).split(',').map((s) => s.trim());
      if (!estados.every((e) => ESTADOS_VALIDOS.includes(e))) {
        return res.status(400).json({ ok: false, mensaje: 'Estado no válido.' });
      }
      where.estado = estados.length === 1 ? estados[0] : estados;
    }
    // El negocio no debe ver pedidos con tarjeta/MP hasta que el pago esté
    // capturado — antes aparecían en la lista apenas se creaban, sin importar
    // si el cliente ya había pagado.
    where[Op.and] = [
      {
        [Op.or]: [
          { metodo_pago: { [Op.notIn]: ['tarjeta', 'mercado_pago', 'transferencia'] } },
          { pago_estado: 'capturado' },
        ],
      },
    ];

    const pedidos = await Pedido.findAll({
      where,
      order: [['creado_en', 'DESC']],
      limit: 50,
      include: [
        { model: Usuario, as: 'cliente', attributes: ['id', 'nombre', 'telefono', 'foto_perfil'] },
        {
          // Mismo hallazgo que en misPedidos (cliente): antes se traía la
          // fila completa de Repartidor (clabe_bancaria desencriptada,
          // documentos, ubicación GPS, notas de moderación) a cada negocio
          // por cada pedido de su historial. Restringido a lo que la UI usa.
          model: Repartidor, as: 'repartidor',
          attributes: ['id', 'calificacion_promedio', 'marca_vehiculo', 'color_vehiculo'],
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

    // El rol efectivo para ESTE pedido se determina por relación real con el
    // pedido (¿eres el repartidor asignado? ¿el dueño del negocio? ¿el cliente?),
    // NO por el toggle de UI modo_activo — ese puede estar desincronizado (p. ej.
    // cuentas repartidor/negocio cuyo modo_activo quedó en 'cliente' por defecto)
    // y bloquear incorrectamente a quien sí tiene permiso real sobre el pedido.
    const esAdmin = req.usuario.rol === 'admin' || req.usuario.modo_activo === 'admin';
    let rolEfectivo;
    let repActual = null;

    if (esAdmin) {
      rolEfectivo = 'admin';
    } else {
      repActual = await Repartidor.findOne({ where: { usuario_id: req.usuario.id }, attributes: ['id'] });
      if (repActual && pedido.repartidor_id && String(pedido.repartidor_id) === String(repActual.id)) {
        rolEfectivo = 'repartidor';
      } else if (pedido.negocio?.usuario_id === req.usuario.id) {
        rolEfectivo = 'negocio';
      } else if (pedido.cliente_id === req.usuario.id) {
        rolEfectivo = 'cliente';
      } else {
        return res.status(403).json({ ok: false, mensaje: 'Este pedido no te pertenece.' });
      }
    }

    if (rolEfectivo === 'negocio') {
      // El negocio debe estar aprobado para operar pedidos
      const negocioActivo = await Negocio.findOne({
        where: { usuario_id: req.usuario.id, verificacion_estado: 'aprobado' },
        attributes: ['id', 'bloqueado_por_deuda', 'estado_cuenta'],
      });
      if (!negocioActivo) {
        return res.status(403).json({ ok: false, mensaje: 'Tu negocio no está aprobado para operar.' });
      }
      if (negocioActivo.bloqueado_por_deuda) {
        return res.status(403).json({ ok: false, mensaje: 'Tu negocio está bloqueado por deuda. Liquida tu saldo primero.' });
      }
      if (['suspendido', 'bloqueado'].includes(negocioActivo.estado_cuenta)) {
        return res.status(403).json({ ok: false, mensaje: 'Tu cuenta está restringida. Contacta a soporte.' });
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
      const metodoDigital = ['tarjeta', 'mercado_pago', 'transferencia'].includes(pedido.metodo_pago);
      if (metodoDigital && pedido.pago_estado !== 'capturado') {
        return res.status(402).json({
          ok: false,
          mensaje: 'El pago aún no ha sido confirmado. Espera la notificación de pago antes de aceptar el pedido.',
          codigo: 'PAGO_PENDIENTE',
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
    const camposActualizar = { estado };
    if (timestamps[estado]) camposActualizar[timestamps[estado]] = new Date();

    if (estado === 'en_envio' && req.body.numero_guia) {
      camposActualizar.numero_guia = req.body.numero_guia;
    }

    // Validar código al entregar — el código SIEMPRE es obligatorio para cerrar
    // una entrega a domicilio (en_camino -> entregado), sin importar quién hace
    // la llamada (repartidor o admin). Antes solo se exigía si rolEfectivo era
    // 'repartidor', dejando a un admin cerrar el pedido sin código.
    // En PICKUP el pedido pasa de 'listo' a 'entregado' cuando el cliente
    // llega al mostrador — y ahí el código importa igual: es lo que prueba
    // que se le entregó a quien hizo el pedido y no a cualquiera que dijo su
    // nombre. Antes esta transición no pedía nada.
    // NINGÚN pedido se cierra sin el código del cliente. Un solo candado para
    // TODOS los caminos a 'entregado' — a domicilio, para recoger y por
    // paquetería — y para TODOS los roles, admin incluido. Antes cada camino
    // tenía su propia regla: el de paquetería (en_envio → entregado) no pedía
    // nada, así que ese pedido se podía dar por entregado sin ninguna prueba.
    // El código lo tiene solo el cliente (obtenerPedido se lo oculta a
    // repartidor y negocio), así que exigirlo es exigir que el cliente esté
    // presente. Si un pedido no se puede entregar, el camino es CANCELARLO,
    // no cerrarlo como si hubiera llegado.
    if (estado === 'entregado') {
      const codigoProvisto = req.body.codigo_entrega;
      const mensajePedirCodigo = pedido.tipo_envio === 'pickup'
        ? 'Pide al cliente su código de entrega (lo tiene en la app) para confirmar que se lo entregaste.'
        : 'Ingresa el código de entrega del cliente para confirmar.';

      if (!codigoProvisto) {
        return res.status(400).json({ ok: false, mensaje: mensajePedirCodigo, codigo: 'CODIGO_REQUERIDO' });
      }
      if (String(codigoProvisto) !== String(pedido.codigo_entrega)) {
        return res.status(400).json({
          ok: false,
          mensaje: 'Código incorrecto. Pídeselo de nuevo al cliente.',
          codigo: 'CODIGO_INCORRECTO',
        });
      }

      // La foto es evidencia adicional opcional, no reemplaza el código
      if (req.body.foto_entrega) {
        try {
          const ruta = `entregas/${pedido.id}_${Date.now()}.jpg`;
          const url = await subirImagen('documentos-negocios', ruta, req.body.foto_entrega, 'image/jpeg');
          camposActualizar.foto_entrega = url;
        } catch (_) {}
      }
    }

    const ESTADOS_TERMINALES = ['entregado', 'cancelado', 'rechazado'];
    const estadoPrevio = pedido.estado;

    // VULNERABILIDAD REAL corregida 2026-07-24: `admin: '*'` en
    // transicionesPermitidas se salta la tabla de transiciones por completo
    // — un admin podía volver a mandar el MISMO estado terminal (ej.
    // 'cancelado' sobre un pedido YA 'cancelado') y el candado atómico de
    // abajo (pensado solo para RACES entre dos requests casi simultáneas)
    // lo dejaba pasar igual, porque compara contra el valor actual en DB,
    // no contra si es un cambio real. Cada repetición re-disparaba
    // procesarEntrega/reembolso/devolución de crédito/registro de pérdida
    // de nuevo — duplicando deuda, reembolsos y crédito otorgado sin
    // límite. Los estados terminales ahora son inmutables: nadie, ni
    // admin, puede "transicionar" un pedido que ya llegó a uno.
    if (ESTADOS_TERMINALES.includes(estadoPrevio)) {
      return res.status(400).json({ ok: false, mensaje: `Este pedido ya está en un estado final ("${estadoPrevio}") y no se puede modificar.` });
    }

    // Transición ATÓMICA: solo aplica si el pedido sigue en el estado que
    // leímos al principio. Evita que dos requests casi simultáneas (doble-tap,
    // reintento de red) disparen procesarEntrega() dos veces y dupliquen la
    // deuda del negocio u otros efectos económicos.
    const [affectedCount] = await Pedido.update(camposActualizar, {
      where: { id: pedido.id, estado: estadoPrevio },
    });
    if (affectedCount === 0) {
      return res.status(409).json({ ok: false, mensaje: 'Este pedido ya fue actualizado por otra solicitud. Refresca e intenta de nuevo.' });
    }
    Object.assign(pedido, camposActualizar);

    // Bitácora en vivo: cada transición del pedido llega al chat del dueño,
    // para poder seguir un pedido completo sin abrir la base.
    eventos.pedidoCambioEstado(pedido, estadoPrevio,
      req.usuario?.nombre ? `${req.usuario.nombre} (${rolEfectivo || req.usuario.modo_activo || req.usuario.rol})` : null);

    // Al cancelar/rechazar un pedido con cobro digital YA capturado: reembolso
    // automático vía la Refunds API de MP. Independiente de esto y de
    // `metodo_pago` (aplica también a efectivo): si el pedido tenía crédito
    // de plataforma aplicado, esa porción SIEMPRE se devuelve como crédito
    // — nunca pasó por MP ni se cobró en mano, un refund a la tarjeta o el
    // cobro en efectivo no la tocan.
    if (['cancelado', 'rechazado'].includes(estado)
        && ['tarjeta', 'mercado_pago'].includes(pedido.metodo_pago)
        && pedido.pago_estado === 'capturado'
        && !String(pedido.pago_referencia || '').startsWith('CREDITO-')) {
      try {
        const reembolso = await pagosService.reembolsarPagoMP(pedido);
        if (reembolso.ok) {
          const montoMP = parseFloat(pedido.total) - parseFloat(pedido.credito_aplicado || 0);
          console.log(`[reembolso] ${pedido.numero} ${estado} — $${montoMP} reembolsados a la tarjeta.`);
          tg.enviarAdmin(`↩️ Pedido <b>${pedido.numero}</b> ${estado} con pago capturado — se reembolsaron $${montoMP.toFixed(2)} a la tarjeta.`).catch(() => {});
        }
      } catch (e) {
        console.error(`[reembolso] FALLO en ${pedido.numero}:`, e.response?.data || e.message);
        tg.enviarAdmin(`⚠️ Pedido <b>${pedido.numero}</b> ${estado} con pago capturado pero el reembolso automático FALLÓ — hacerlo manual en el panel de MP (payment ${pedido.pago_referencia}).`).catch(() => {});
      }
    }

    // Pedido pagado 100% con crédito (nunca hubo cobro real, ni MP ni
    // efectivo): al cancelarse/rechazarse solo se marca reembolsado.
    if (['cancelado', 'rechazado'].includes(estado)
        && pedido.pago_estado === 'capturado'
        && String(pedido.pago_referencia || '').startsWith('CREDITO-')) {
      pedido.pago_estado = 'reembolsado';
      await pedido.save();
    }

    // Devolución de crédito — SIEMPRE que hubiera crédito aplicado en este
    // pedido, sin importar el método de pago ni si el resto ya se reembolsó
    // por otro camino arriba.
    if (['cancelado', 'rechazado'].includes(estado) && parseFloat(pedido.credito_aplicado || 0) > 0) {
      try {
        await creditosService.devolverCredito({
          usuarioId: pedido.cliente_id,
          monto: pedido.credito_aplicado,
          motivo: `Devolución de crédito — pedido ${pedido.numero} ${estado}.`,
          pedidoId: pedido.id,
        });
        tg.enviarAdmin(`💳 $${parseFloat(pedido.credito_aplicado).toFixed(2)} de crédito devueltos al cliente por el pedido <b>${pedido.numero}</b> (${estado}).`).catch(() => {});
      } catch (e) {
        console.error(`[credito] FALLO devolviendo crédito de ${pedido.numero}:`, e.message);
        tg.enviarAdmin(`⚠️ Pedido <b>${pedido.numero}</b> ${estado} tenía $${parseFloat(pedido.credito_aplicado).toFixed(2)} de crédito aplicado — la devolución automática FALLÓ, hacerla manual.`).catch(() => {});
      }
    }

    // Pedido PERDIDO (modelo cuenta concentradora 2026-07-23): si al
    // cancelarse/rechazarse la comida ya estaba en producción o en la calle
    // (preparando/listo/en_camino), se registra la pérdida y sus cargos:
    // 50% restaurante / 50% plataforma por default; un admin puede
    // reclasificarla a intencional (60% al repartidor) o eliminarla si una
    // aclaración procede. También alimenta el bloqueo permanente del
    // repartidor al 3er pedido perdido.
    if (['cancelado', 'rechazado'].includes(estado)
        && ['preparando', 'listo', 'en_camino'].includes(estadoPrevio)) {
      try {
        const { registrarPerdida } = require('../services/perdidas.service');
        await registrarPerdida({ pedido, nota: `Cancelado desde "${estadoPrevio}" por ${rolEfectivo}.` });
      } catch (e) {
        console.error(`[perdidas] FALLO registrando pérdida de ${pedido.numero}:`, e.message);
        tg.enviarAdmin(`⚠️ No se pudo registrar la pérdida del pedido <b>${pedido.numero}</b> — revisar manual.`).catch(() => {});
      }
    }

    // Al entregar: economía.
    // PICKUP no tiene repartidor, y este bloque estaba condicionado a que lo
    // hubiera — así que un pedido para recoger en tienda se cerraba SIN
    // ledger, sin comisión y sin deuda del restaurante: ingreso $0 para la
    // plataforma y cero rastro contable de la venta.
    if (estado === 'entregado') {
      const esPickupEntregado = pedido.tipo_envio === 'pickup';
      if (pedido.repartidor_id || esPickupEntregado) {
        try {
          const repartidor = pedido.repartidor_id
            ? await Repartidor.findByPk(pedido.repartidor_id)
            : null;
          if (repartidor || esPickupEntregado) await procesarEntrega({ pedido, repartidor });
        } catch (e) {
          console.error('Error en procesarEntrega:', e.message);
        }
      }
      try {
        const negocioEntregado = await Negocio.findByPk(pedido.negocio_id);
        const dueno = negocioEntregado
          ? await Usuario.findByPk(negocioEntregado.usuario_id, { attributes: ['telegram_chat_id'] })
          : null;
        if (dueno?.telegram_chat_id) tg.alertaPedidoEntregado(dueno.telegram_chat_id, pedido).catch(() => {});
      } catch (_) {}
    }

    // Si el pedido llegó a un estado terminal y pertenecía a una ruta de
    // repartidor, cerramos el batch cuando ya no le queda ningún pedido
    // pendiente — evita que rutas viejas se queden "activas" para siempre y
    // bloqueen al repartidor de aceptar pedidos nuevos.
    if (ESTADOS_TERMINALES.includes(estado) && pedido.batch_id) {
      try {
        const pendientesEnBatch = await Pedido.count({
          where: { batch_id: pedido.batch_id, estado: { [Op.notIn]: ESTADOS_TERMINALES } },
        });
        if (pendientesEnBatch === 0) {
          await DeliveryBatch.update(
            { status: 'completed', completed_at: new Date() },
            { where: { id: pedido.batch_id, status: 'active' } }
          );
        }
      } catch (e) {
        console.error('Error cerrando batch:', e.message);
      }
    }

    // Notificaciones en tiempo real
    const io = req.app.get('io');
    const payloadBase = { pedido_id: pedido.id, numero: pedido.numero, estado, actualizado_en: new Date() };

    // VULNERABILIDAD CORREGIDA (2026-07-30): el código de entrega se emitía
    // a `pedido:<id>`, una sala donde también están el REPARTIDOR y el
    // negocio. Es decir, el repartidor recibía el código del cliente en el
    // instante de ponerse en camino y podía cerrar la entrega sin haber
    // llegado con nadie — justo lo que ese código existe para impedir (la
    // capa REST sí lo ocultaba: obtenerPedido lo borra si no eres el
    // cliente). Ahora el código va SOLO a la sala privada del cliente.
    io.to(`pedido:${pedido.id}`).emit('estado_pedido', payloadBase);
    if (['en_camino', 'listo'].includes(estado) && pedido.codigo_entrega) {
      io.to(`usuario:${pedido.cliente_id}`).emit('estado_pedido', {
        ...payloadBase,
        codigo_entrega: pedido.codigo_entrega,
      });
    }
    if (pedido.negocio_id) io.to(`negocio:${pedido.negocio_id}`).emit('estado_pedido', payloadBase);

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

        // Aviso especial al repartidor QUE YA VA EN RUTA y puede sumar este
        // pedido sin desviarse (hasta 3 en total). Es su oportunidad de
        // duplicar la ganancia del mismo viaje — sin este aviso tendría que
        // estar mirando la lista de disponibles justo en ese momento.
        await avisarRepartidoresEnRutaCompatible(pedido, io);
      } catch (e) {
        console.warn('[notif] Error notificando repartidores en listo:', e.message);
      }
    }

    res.json({ ok: true, mensaje: `Pedido actualizado a: ${estado}`, data: { pedido } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar el estado.' });
  }
};

// ─── GET /api/pedidos/disponibilidad ─────────────────────
// La app lo consulta ANTES de mostrar las opciones de envío: si nadie puede
// entregar en este momento, solo se ofrece pickup. El mensaje va enmarcado
// como beneficio (te ahorras el envío), nunca como "no tenemos repartidores".
// Query: negocio_id (opcional, para tomar su ciudad)
const disponibilidadEnvio = async (req, res) => {
  try {
    let ciudad = CIUDAD_DEFAULT;
    if (req.query.negocio_id) {
      const negocio = await Negocio.findByPk(req.query.negocio_id, { attributes: ['ciudad'] });
      if (negocio?.ciudad) ciudad = negocio.ciudad;
    }
    const disponibilidad = await hayRepartidoresParaEnvio(ciudad);
    const feeStandard = calcularFeeCliente({ tipoEnvio: 'standard' });

    res.json({
      ok: true,
      data: {
        envio_disponible: disponibilidad.disponible,
        // Tipos de envío que la app debe ofrecer en este momento
        tipos_disponibles: disponibilidad.disponible
          ? ['standard', 'express', 'pickup']
          : ['pickup'],
        mensaje: disponibilidad.disponible ? null : mensajeSoloPickup(Date.now() % 997),
        ahorro_envio: disponibilidad.disponible ? 0 : feeStandard,
      },
    });
  } catch (error) {
    console.error('[disponibilidad] error:', error.message);
    // Ante un error, no se le apaga el envío a nadie: la app ofrece todo y el
    // candado real sigue estando en crearPedido.
    res.json({ ok: true, data: { envio_disponible: true, tipos_disponibles: ['standard', 'express', 'pickup'], mensaje: null } });
  }
};

// ─── Aviso de "otro pedido en tu misma ruta" ─────────────
// Cuando un pedido queda LISTO, busca a los repartidores que ya traen una
// ruta activa con cupo (máx. `max_pedidos_ruta`, 3 por defecto) y a los que
// este pedido les queda de paso según services/ruta.service. A esos se les
// manda un aviso aparte, porque para ellos vale más: es otra tarifa completa
// en el mismo viaje. Los Express nunca entran (viajan solos).
//
// Nunca lanza: es una mejora de reparto, no debe tumbar la transición de
// estado del pedido si algo falla.
const ESTADOS_TERMINALES_RUTA = ['entregado', 'cancelado', 'rechazado'];

const avisarRepartidoresEnRutaCompatible = async (pedido, io) => {
  try {
    if (pedido.tipo_envio === 'express') return;
    const { evaluarCompatibilidad } = require('../services/ruta.service');

    const negocioCandidato = await Negocio.findByPk(pedido.negocio_id, {
      attributes: ['id', 'nombre', 'latitud', 'longitud'],
    });
    if (!negocioCandidato?.latitud || !negocioCandidato?.longitud) return;

    const batches = await DeliveryBatch.findAll({
      where: { status: 'active' },
      include: [{
        model: Pedido, as: 'pedidos', required: true,
        where: { estado: { [Op.notIn]: ESTADOS_TERMINALES_RUTA } },
        attributes: ['id', 'negocio_id', 'tipo_envio', 'latitud_entrega', 'longitud_entrega'],
      }],
    });
    if (batches.length === 0) return;

    const idsNegocios = [...new Set(batches.flatMap((b) => b.pedidos.map((p) => p.negocio_id)))];
    const negocios = await Negocio.findAll({
      where: { id: { [Op.in]: idsNegocios } },
      attributes: ['id', 'latitud', 'longitud'],
    });
    const porId = Object.fromEntries(negocios.map((n) => [String(n.id), n]));

    for (const batch of batches) {
      const enRuta = batch.pedidos;
      const maxOrders = batch.max_orders || 3;
      if (enRuta.length === 0 || enRuta.length >= maxOrders) continue;

      const evaluacion = evaluarCompatibilidad({
        candidato: { pedido, negocio: negocioCandidato },
        enRuta: enRuta.map((p) => ({ pedido: p, negocio: porId[String(p.negocio_id)] })),
      });
      if (!evaluacion.compatible) continue;

      const repartidor = await Repartidor.findOne({
        where: { id: batch.driver_id, verificacion_estado: 'aprobado' },
        include: [{ model: Usuario, as: 'usuario', attributes: ['token_push'] }],
      });
      // Un repartidor suspendido/bloqueado no debe recibir la invitación:
      // aceptarPedido se la iba a rechazar de todos modos.
      if (!repartidor || ['suspendido', 'bloqueado'].includes(repartidor.estado_cuenta)) continue;
      if (pedido.ciudad && repartidor.ciudad && pedido.ciudad !== repartidor.ciudad) continue;

      io.to(`repartidor:${repartidor.id}`).emit('pedido_en_tu_ruta', {
        pedido_id:  pedido.id,
        numero:     pedido.numero,
        negocio:    negocioCandidato.nombre,
        pago:       parseFloat(pedido.fee_cliente || pedido.costo_envio || 0),
        km_entrega: evaluacion.kmEntrega ?? null,
        lugares_libres: maxOrders - enRuta.length,
        motivo:     evaluacion.motivo,
      });
      if (repartidor.usuario?.token_push) {
        push.notificarPedidoEnTuRuta(repartidor.usuario.token_push, pedido, evaluacion).catch(() => {});
      }
      console.log(`[ruta] ${pedido.numero} ofrecido al repartidor ${repartidor.id} — ${evaluacion.motivo}`);
    }
  } catch (e) {
    console.warn('[ruta] No se pudo avisar a repartidores en ruta:', e.message);
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
    if (pedido.calificacion_negocio !== null || pedido.calificacion_repartidor !== null) {
      return res.status(400).json({ ok: false, mensaje: 'Ya calificaste este pedido.' });
    }
    // Propina al calificar: SOLO para pedidos en EFECTIVO (se da en mano al
    // entregar — aquí solo se registra para estadísticas, nunca toca el
    // fondo). En tarjeta la propina se elige en el CHECKOUT, viaja dentro
    // del cargo real a la tarjeta y se acredita al fondo del repartidor en
    // procesarEntrega — aceptar otra aquí duplicaría o acreditaría dinero
    // nunca cobrado (bug corregido 2026-07-23).
    const propinaFinal = (pedido.metodo_pago === 'efectivo' && propinaNum > 0) ? propinaNum : parseFloat(pedido.propina || 0);
    await pedido.update({
      calificacion_repartidor: calificacion_repartidor || null,
      calificacion_negocio,
      comentario,
      propina: propinaFinal,
    });

    // Queja del cliente: calificación baja (1-2★) y/o comentario escrito —
    // antes esto solo se acumulaba en silencio hasta cruzar el umbral de
    // baja permanente (6+ calificaciones); una queja individual nunca
    // llegaba a nadie hasta entonces. Ahora avisa a admin de inmediato.
    const calNeg = calificacion_negocio ? Number(calificacion_negocio) : null;
    const calRep = calificacion_repartidor ? Number(calificacion_repartidor) : null;
    if ((calNeg && calNeg <= 2) || (calRep && calRep <= 2) || (comentario && comentario.trim())) {
      tg.enviarAdmin(
        `📣 <b>Queja de cliente</b> — pedido <b>${pedido.numero}</b>\n` +
        (calNeg ? `Negocio: ${calNeg}★\n` : '') +
        (calRep ? `Repartidor: ${calRep}★\n` : '') +
        (comentario?.trim() ? `Comentario: "${comentario.trim()}"` : '')
      ).catch(() => {});
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
          attributes: ['calificacion_repartidor', 'cliente_id'],
        });
        const sumaRep = califsRep.reduce((acc, p) => acc + p.calificacion_repartidor, 0);
        const promedioRep = sumaRep / califsRep.length;
        const clientesDistintos = new Set(califsRep.map((p) => p.cliente_id)).size;
        await repartidor.update({ calificacion_promedio: promedioRep.toFixed(2) });

        // ─── Baja permanente por calificación reprobatoria ──────
        // 6+ pedidos calificados (de al menos 4 clientes DISTINTOS, para
        // que un solo cliente repitiendo pedidos no pueda forzar la baja
        // por su cuenta) y promedio < 3★ → se da de baja para siempre (no
        // es una suspensión temporal). Su placa queda vetada permanentemente.
        if (
          repartidor.estado_cuenta !== 'bloqueado' &&
          califsRep.length >= CALIFICACIONES_MIN_PARA_BAJA &&
          clientesDistintos >= CLIENTES_DISTINTOS_MIN_PARA_BAJA &&
          promedioRep < CALIFICACION_MIN_PROMEDIO
        ) {
          await bloquearRepartidorPermanente(
            repartidor,
            `Baja permanente automática: calificación de ${promedioRep.toFixed(2)}★ en ${califsRep.length} pedidos (mínimo ${CALIFICACION_MIN_PROMEDIO}★). No puede volver a operar con VoyCorriendo.`
          );
          try {
            const duenoRep = await Usuario.findByPk(repartidor.usuario_id, { attributes: ['telegram_chat_id', 'token_push'] });
            const mensajeBaja = `🚫 Tu cuenta de repartidor fue dada de baja permanente por calificación promedio de ${promedioRep.toFixed(2)}★ en tus últimos ${califsRep.length} pedidos (mínimo requerido: ${CALIFICACION_MIN_PROMEDIO}★). Ni tú ni tu vehículo podrán volver a registrarse en VoyCorriendo. Si crees que es un error, contacta a atención a clientes.`;
            if (duenoRep?.telegram_chat_id) tg.enviar(duenoRep.telegram_chat_id, mensajeBaja).catch(() => {});
            if (duenoRep?.token_push) push.enviarPush(duenoRep.token_push, 'Cuenta dada de baja', mensajeBaja).catch(() => {});
          } catch (_) {}
        }
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

    // Si no podemos determinar la distancia (negocio sin coordenadas, o el
    // cliente no compartió su ubicación), NO decimos "dentro de cobertura" —
    // crearPedido rechaza este mismo caso, así que decirlo aquí sería mentir
    // en el carrito y luego fallar sorpresivamente al confirmar.
    if (!negocio.latitud || !negocio.longitud) {
      return res.json({
        ok: true,
        data: {
          distancia_km: null,
          zona: null,
          costo_envio: 0,
          fuera_de_cobertura: true,
          aviso: 'Este negocio aún no tiene su ubicación configurada y no puede recibir pedidos a domicilio por ahora.',
        },
      });
    }
    if (lat == null || lng == null) {
      const tarifa = await calcularCostoEnvio({ distanciaKm: 1, tipoEnvio: tipo_envio });
      return res.json({
        ok: true,
        data: {
          distancia_km: null,
          zona: tarifa.zona,
          costo_envio: tarifa.costo,
          // No es "fuera de cobertura" en sentido estricto, pero sin GPS
          // crearPedido va a rechazar el pedido igual — lo marcamos para que
          // el carrito no deje avanzar con una falsa sensación de "listo".
          fuera_de_cobertura: true,
          aviso: 'Activa el GPS y detecta tu ubicación para poder confirmar tu pedido.',
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

// ─── POST /api/pedidos/ine-foto ───────────────────────────
// Sube la foto del INE del cliente a Supabase Storage y devuelve
// la URL pública para adjuntarla al crear un pedido con productos
// que requieren validación de edad. Body: { base64, mime }
const subirFotoINE = async (req, res) => {
  try {
    const { base64, mime } = req.body;
    if (!base64 || !mime) {
      return res.status(400).json({ ok: false, mensaje: 'Falta base64 o mime.' });
    }

    const ext = safeExt(mime);
    const ruta = `clientes/${req.usuario.id}/ine_${Date.now()}.${ext}`;
    const url = await subirImagen('documentos-clientes', ruta, base64, mime);

    res.json({ ok: true, mensaje: 'Foto de INE subida.', data: { url } });
  } catch (error) {
    console.error('Error en subirFotoINE:', error);
    res.status(500).json({
      ok: false,
      mensaje: error.message || 'No se pudo subir la foto. Intenta de nuevo.',
    });
  }
};

// ─── GET /api/pedidos/:id/ruta ─────────────────────────────
// Ruta REAL por calles para el mapa en vivo: repartidor → negocio → entrega.
// La posición del repartidor viaja en query (?lat&lng) porque cambia cada
// pocos segundos y no vale la pena leerla de la DB.
//
// Devuelve `ruta: null` cuando Google no está disponible; la app dibuja
// entonces la línea recta. Que no haya ruta por calles no debe dejar sin
// mapa a nadie.
const rutaDelPedido = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, {
      attributes: ['id', 'cliente_id', 'repartidor_id', 'negocio_id', 'latitud_entrega', 'longitud_entrega', 'recogido_en'],
      include: [
        { model: Negocio, as: 'negocio', attributes: ['id', 'usuario_id', 'latitud', 'longitud'] },
        { model: Repartidor, as: 'repartidor', attributes: ['id', 'usuario_id'] },
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

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const repartidorPos = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

    // Si ya recogió, el tramo al negocio sobra: va derecho a entregar.
    const negocioPos = !pedido.recogido_en && pedido.negocio?.latitud && pedido.negocio?.longitud
      ? { lat: pedido.negocio.latitud, lng: pedido.negocio.longitud }
      : null;
    const entregaPos = pedido.latitud_entrega && pedido.longitud_entrega
      ? { lat: pedido.latitud_entrega, lng: pedido.longitud_entrega }
      : null;

    const ruta = await rutaPorCalles([repartidorPos, negocioPos, entregaPos].filter(Boolean));
    res.json({ ok: true, data: { ruta } });
  } catch (error) {
    console.error('Error en rutaDelPedido:', error);
    res.status(500).json({ ok: false, mensaje: 'No se pudo calcular la ruta.' });
  }
};

module.exports = {
  crearPedido, misPedidos, obtenerPedido, actualizarEstado,
  calificarPedido, pedidosDelNegocio, cotizarEnvio, disponibilidadEnvio, subirFotoINE,
  rutaDelPedido,
};
