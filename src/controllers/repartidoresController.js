const { Repartidor, Usuario, Pedido, Negocio, DeliveryBatch, FondoRepartidor, LedgerConciliacion, Liquidacion } = require('../models');
const { Op } = require('sequelize');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const { subirImagen } = require('../services/storage.service');

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const safeExt = (mime) => MIME_EXT[(mime || '').toLowerCase()] || 'jpg';
const { calcularRuta } = require('../services/routing.service');
const tg = require('../services/telegram.service');
const push = require('../services/notificaciones.service');
const { validarPlacaRepartidor, bloquearRepartidorPermanente } = require('../services/seguridadCuentas.service');
const { CALIFICACION_MIN_PROMEDIO, CALIFICACIONES_MIN_PARA_BAJA } = require('../config/precios');

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

    // ─── Candado: la misma moto (placa) no puede estar en dos cuentas ──
    // Centralizado en seguridadCuentas.service — NO repetir este chequeo a
    // mano en otro endpoint, usar validarPlacaRepartidor siempre.
    if (req.body.placa_vehiculo !== undefined) {
      const resultado = await validarPlacaRepartidor(repartidor.id, req.body.placa_vehiculo);
      if (!resultado.ok) {
        repartidor.placa_vehiculo = req.body.placa_vehiculo;
        if (resultado.permanente) {
          repartidor.estado_cuenta = 'bloqueado';
          repartidor.estado_motivo = `Placa está en lista negra permanente (${resultado.motivo}).`;
          await repartidor.save();
          return res.status(403).json({
            ok: false,
            mensaje: 'Esta moto y/o usuario están bloqueados permanentemente. Comunícate con atención a clientes.',
          });
        }
        await bloquearRepartidorPermanente(repartidor, resultado.motivo);
        return res.status(403).json({
          ok: false,
          mensaje: 'Esa placa ya está registrada en otra cuenta. Tu cuenta quedó bloqueada — contacta a atención a clientes.',
        });
      }
    }

    const camposEditables = [
      'tipo_vehiculo', 'marca_vehiculo', 'modelo_vehiculo',
      'anio_vehiculo', 'placa_vehiculo', 'color_vehiculo',
      'clabe_bancaria', 'banco',
      'foto_ine_frente', 'foto_ine_reverso',
      'foto_licencia', 'foto_tarjeta_circulacion',
      // 'tier' — solo admin puede asignar tiers
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
    const tiposRepartidor = {
      ine_frente: 'foto_ine_frente',
      ine_reverso: 'foto_ine_reverso',
      licencia: 'foto_licencia',
      tarjeta_circulacion: 'foto_tarjeta_circulacion',
    };
    const esFotoPerfil = tipo === 'foto_perfil';
    const columna = tiposRepartidor[tipo];

    if (!esFotoPerfil && !columna) {
      return res.status(400).json({ ok: false, mensaje: 'Tipo de foto invalido.' });
    }
    if (!base64 || !mime) {
      return res.status(400).json({ ok: false, mensaje: 'Falta base64 o mime.' });
    }

    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) {
      return res.status(404).json({ ok: false, mensaje: 'Activa primero el modo repartidor.' });
    }

    const ext = safeExt(mime);

    if (esFotoPerfil) {
      const ruta = `repartidores/${req.usuario.id}/perfil_${Date.now()}.${ext}`;
      const url = await subirImagen('documentos-repartidores', ruta, base64, mime);
      await req.usuario.update({ foto_perfil: url });
      return res.json({ ok: true, mensaje: 'Foto de perfil guardada.', data: { url, tipo } });
    }

    // Documentos del repartidor
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
    if (!repartidor.banco) faltantes.push('banco');
    if (!repartidor.foto_ine_frente) faltantes.push('foto INE frente');
    if (!repartidor.foto_ine_reverso) faltantes.push('foto INE reverso');
    if (!repartidor.foto_licencia) faltantes.push('foto licencia');
    if (!req.usuario.foto_perfil) faltantes.push('selfie de perfil');
    if (faltantes.length) {
      return res.status(400).json({
        ok: false,
        mensaje: `Faltan datos: ${faltantes.join(', ')}.`,
      });
    }
    // Defensa en profundidad: la placa ya se valida en actualizarPerfil,
    // esto cubre cualquier otro camino que la haya fijado (incluye ahora
    // el chequeo de lista negra permanente, que antes faltaba aquí).
    const resultadoPlaca = await validarPlacaRepartidor(repartidor.id, repartidor.placa_vehiculo);
    if (!resultadoPlaca.ok) {
      if (resultadoPlaca.permanente) {
        repartidor.estado_cuenta = 'bloqueado';
        repartidor.estado_motivo = `Placa está en lista negra permanente (${resultadoPlaca.motivo}).`;
        await repartidor.save();
        return res.status(403).json({
          ok: false,
          mensaje: 'Esta moto y/o usuario están bloqueados permanentemente. Comunícate con atención a clientes.',
        });
      }
      await bloquearRepartidorPermanente(repartidor, resultadoPlaca.motivo);
      return res.status(403).json({
        ok: false,
        mensaje: 'Esa placa ya está registrada en otra cuenta. Tu cuenta quedó bloqueada — contacta a atención a clientes.',
      });
    }
    repartidor.verificacion_estado = 'en_revision';
    repartidor.enviado_revision_en = new Date();
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

    // Mismo candado que actualizarPerfil — este endpoint legacy se había
    // quedado sin el chequeo, permitiendo evadir por completo el bloqueo
    // de placa duplicada/vetada con solo registrar una cuenta nueva.
    const resultadoPlaca = await validarPlacaRepartidor(null, placa_vehiculo);
    if (!resultadoPlaca.ok) {
      return res.status(403).json({
        ok: false,
        mensaje: resultadoPlaca.permanente
          ? 'Esta moto y/o usuario están bloqueados permanentemente. Comunícate con atención a clientes.'
          : 'Esa placa ya está registrada en otra cuenta. Contacta a atención a clientes.',
      });
    }

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

// ─── GET /api/repartidores/mi-perfil ─────────────────────
const miPerfil = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({
      where: { usuario_id: req.usuario.id },
      attributes: { exclude: ['clabe_bancaria'] },
    });
    if (!repartidor) return res.status(404).json({ ok: false, mensaje: 'Perfil no encontrado.' });
    res.json({ ok: true, data: { repartidor } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener perfil.' });
  }
};

// ─── GET /api/repartidores/mis-entregas?periodo=hoy|semana|mes ───────────────
const misEntregas = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) return res.status(404).json({ ok: false, mensaje: 'Perfil no encontrado.' });

    const { periodo = 'semana' } = req.query;
    const ahora = new Date();
    let desde;
    if (periodo === 'hoy') {
      desde = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
    } else if (periodo === 'mes') {
      desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    } else {
      desde = new Date(ahora - 7 * 24 * 60 * 60 * 1000);
    }

    // Solo entregas COMPLETADAS — antes traía cualquier pedido asignado en el
    // período (incluidos cancelados/en curso), inflando el conteo y mezclando
    // pedidos sin ganancia real en una pantalla que se presenta como historial
    // de entregas. Así queda consistente con /repartidores/ganancias, que
    // también solo cuenta estado: 'entregado'.
    const entregas = await Pedido.findAll({
      where: {
        repartidor_id: repartidor.id,
        estado: 'entregado',
        creado_en: { [Op.gte]: desde },
      },
      order: [['creado_en', 'DESC']],
      limit: 100,
    });

    // Usa el pago_repartidor REAL grabado por procesarEntrega() al entregar
    // (viene de config_comisiones, editable en DB) — antes se recalculaba con
    // una tarifa fija en variables de entorno que podía no coincidir con lo
    // que el repartidor realmente ganó por ese pedido.
    const ganancias = entregas.reduce(
      (sum, p) => sum + parseFloat(p.pago_repartidor || 0) + parseFloat(p.propina || 0), 0
    );

    res.json({
      ok: true,
      data: {
        entregas,
        resumen: {
          periodo,
          total_entregas: entregas.length,
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
      where: { estado: 'listo', repartidor_id: null, ciudad: repartidor.ciudad, tipo_envio: { [Op.ne]: 'pickup' } },
      order: [['creado_en', 'ASC']],
      limit: 10,
      include: [{
        model: Negocio,
        as: 'negocio',
        attributes: ['id', 'nombre', 'direccion', 'latitud', 'longitud'],
      }],
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
    // Un repartidor bloqueado (placa duplicada/vetada, baja por calificación,
    // o bloqueo manual de admin) sigue con verificacion_estado='aprobado' —
    // bloquearRepartidorPermanente solo toca estado_cuenta. Sin este chequeo
    // podía seguir aceptando pedidos nuevos aunque ya estuviera bloqueado.
    if (['suspendido', 'bloqueado'].includes(repartidor.estado_cuenta)) {
      return res.status(403).json({ ok: false, mensaje: 'Tu cuenta está restringida. Contacta a soporte.' });
    }

    const pedido = await Pedido.findOne({
      where: { id: pedido_id, estado: 'listo', repartidor_id: null },
    });
    if (!pedido) {
      return res.status(409).json({ ok: false, mensaje: 'Este pedido ya fue tomado por otro repartidor.' });
    }
    if (pedido.ciudad && pedido.ciudad !== repartidor.ciudad) {
      return res.status(403).json({ ok: false, mensaje: 'Este pedido no corresponde a tu ciudad de operación.' });
    }

    const ESTADOS_TERMINALES = ['entregado', 'cancelado', 'rechazado'];

    // Obtener o crear batch activo del repartidor — solo cuentan los pedidos
    // NO terminales; un batch con todo entregado/cancelado no debe seguir
    // bloqueando al repartidor de aceptar pedidos nuevos.
    let batch = await DeliveryBatch.findOne({
      where: { driver_id: repartidor.id, status: 'active' },
      include: [{ model: Pedido, as: 'pedidos', where: { estado: { [Op.notIn]: ESTADOS_TERMINALES } }, required: false }],
    });

    const maxOrders = repartidor.max_pedidos_ruta || 3;
    const pedidosActivosBatch = batch?.pedidos || [];

    // Si el batch activo ya no tiene pedidos pendientes, se cierra solo y se
    // trata como si el repartidor no tuviera ruta activa.
    if (batch && pedidosActivosBatch.length === 0) {
      await batch.update({ status: 'completed', completed_at: new Date() });
      batch = null;
    }

    // EXPRESS viaja solo — sin batch activo ni compartido
    if (pedido.tipo_envio === 'express' && batch) {
      return res.status(409).json({
        ok: false,
        mensaje: 'Termina tu ruta actual antes de aceptar un pedido Express. Los pedidos Express son exclusivos.',
      });
    }

    // Por ahora una ruta solo combina pedidos del MISMO negocio — no se mezclan
    // recolecciones de restaurantes distintos en un solo viaje.
    if (batch && pedidosActivosBatch.length > 0 && pedidosActivosBatch[0].negocio_id !== pedido.negocio_id) {
      return res.status(409).json({
        ok: false,
        mensaje: 'Ya tienes pedidos en ruta de otro negocio. Termina esa entrega antes de aceptar este.',
      });
    }

    if (batch && pedido.tipo_envio !== 'express' && pedidosActivosBatch.length >= maxOrders) {
      return res.status(409).json({
        ok: false,
        mensaje: `Ya tienes ${maxOrders} pedidos en ruta. Entrega primero antes de tomar más.`,
      });
    }

    if (!batch) {
      batch = await DeliveryBatch.create({
        driver_id: repartidor.id,
        max_orders: pedido.tipo_envio === 'express' ? 1 : maxOrders,
      });
    }

    // Asignar pedido al batch y al repartidor de forma ATÓMICA — evita que
    // dos repartidores "ganen" el mismo pedido si aceptan casi al mismo
    // tiempo (ambos pasan el findOne de arriba antes de que cualquiera
    // escriba). Si affectedCount es 0, alguien más ya se lo quedó.
    // Snapshot inmutable de quién entrega (foto + placa + nombre) — se
    // conserva aunque el repartidor luego cambie su foto o vehículo. Es la
    // fuente de verdad de seguridad de "quién y en qué moto entregó esto".
    const [affectedCount] = await Pedido.update(
      {
        repartidor_id: repartidor.id, batch_id: batch.id, estado: 'en_camino', asignado_en: new Date(),
        repartidor_foto_snapshot:   req.usuario.foto_perfil || null,
        repartidor_placa_snapshot:  repartidor.placa_vehiculo || null,
        repartidor_nombre_snapshot: req.usuario.nombre || null,
      },
      { where: { id: pedido.id, estado: 'listo', repartidor_id: null } }
    );
    if (affectedCount === 0) {
      return res.status(409).json({ ok: false, mensaje: 'Este pedido ya fue tomado por otro repartidor.' });
    }
    await pedido.reload();

    // Recalcular ruta con todos los pedidos NO terminales del batch
    const pedidosEnBatch = await Pedido.findAll({
      where: { batch_id: batch.id, estado: { [Op.notIn]: ESTADOS_TERMINALES } },
    });
    const origen = repartidor.latitud && repartidor.longitud
      ? { lat: parseFloat(repartidor.latitud), lng: parseFloat(repartidor.longitud) }
      : null;

    let rutaData = null;
    if (origen) {
      rutaData = await calcularRuta(origen, pedidosEnBatch);
      await batch.update({
        waypoints:  rutaData?.waypoints  ?? null,
        route_data: rutaData?.route_data ?? null,
      });
    }

    const io = req.app.get('io');
    io.to(`pedido:${pedido.id}`).emit('repartidor_asignado', {
      pedido_id: pedido.id,
      repartidor_id: repartidor.id,
      batch_id: batch.id,
    });
    // Push al cliente con su código de entrega
    try {
      const clientePush = await Usuario.findByPk(pedido.cliente_id, { attributes: ['token_push'] });
      if (clientePush?.token_push) {
        push.notificarCodigoEntrega(clientePush.token_push, pedido).catch(() => {});
      }
    } catch (_) {}
    // Alerta al repartidor vía Telegram
    const driverUser = await Usuario.findByPk(repartidor.usuario_id, { attributes: ['telegram_chat_id'] });
    if (driverUser?.telegram_chat_id) {
      tg.alertaPedidoAsignado(driverUser.telegram_chat_id, pedido).catch(() => {});
    }

    res.json({
      ok: true,
      mensaje: '¡Pedido aceptado!',
      data: {
        pedido,
        batch_id: batch.id,
        total_en_ruta: pedidosEnBatch.length,
        ruta: rutaData,
      },
    });
  } catch (error) {
    console.error('Error en aceptarPedido:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al aceptar el pedido.' });
  }
};

// ─── GET /api/repartidores/mi-ruta ────────────────────────
const miRuta = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) return res.status(404).json({ ok: false, mensaje: 'Perfil no encontrado.' });

    const batch = await DeliveryBatch.findOne({
      where: { driver_id: repartidor.id, status: 'active' },
      include: [{
        model: Pedido,
        as: 'pedidos',
        where: { estado: { [Op.notIn]: ['entregado', 'cancelado', 'rechazado'] } },
        required: false,
        attributes: ['id', 'numero', 'tipo_envio', 'direccion_entrega',
                     'latitud_entrega', 'longitud_entrega', 'estado', 'fee_cliente'],
      }],
    });

    if (!batch || (batch.pedidos || []).length === 0) {
      return res.json({ ok: true, data: { batch: null, mensaje: 'Sin ruta activa.' } });
    }

    res.json({ ok: true, data: { batch } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener la ruta.' });
  }
};

// ─── GET /api/repartidores/ganancias ─────────────────────
const ganancias = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({ where: { usuario_id: req.usuario.id } });
    if (!repartidor) return res.status(404).json({ ok: false, mensaje: 'Perfil no encontrado.' });

    const entregados = await Pedido.findAll({
      where: { repartidor_id: repartidor.id, estado: 'entregado' },
      attributes: ['id', 'numero', 'creado_en', 'pago_repartidor', 'propina', 'metodo_pago', 'total'],
      order: [['creado_en', 'DESC']],
    });

    const totalEnvios   = entregados.reduce((s, p) => s + parseFloat(p.pago_repartidor || 0), 0);
    const totalPropinas = entregados.reduce((s, p) => s + parseFloat(p.propina || 0), 0);
    // Efectivo: el repartidor ya recibió el dinero de mano del cliente al
    // entregar — nunca pasa por la plataforma, cuenta como "pagado" desde ya.
    const gananciaEfectivo = entregados
      .filter(p => p.metodo_pago === 'efectivo')
      .reduce((s, p) => s + parseFloat(p.pago_repartidor || 0) + parseFloat(p.propina || 0), 0);

    const fondo = await FondoRepartidor.findOne({ where: { repartidor_id: repartidor.id } });

    // Envíos de pedidos con tarjeta no conciliados aún (pendientes de pago del viernes)
    const idsEntregados = entregados.filter(p => p.metodo_pago !== 'efectivo').map(p => p.id);
    let porDepositar = 0;
    if (idsEntregados.length > 0) {
      const ledgersPendientes = await LedgerConciliacion.findAll({
        where: { pedido_id: { [Op.in]: idsEntregados }, conciliado_repartidor: false },
        attributes: ['pago_repartidor', 'fee_mp_repartidor'],
      });
      // El fee de MP prorrateado a la porción del repartidor se descuenta
      // de lo que la plataforma le va a depositar.
      porDepositar = ledgersPendientes.reduce((s, l) => s + parseFloat(l.pago_repartidor || 0) - parseFloat(l.fee_mp_repartidor || 0), 0);
    }

    const ingresoGenerado = totalEnvios + totalPropinas;
    // Pagado = efectivo (ya en mano) + lo que un admin ya confirmó transferido
    // (retiros/depósitos ya procesados vía confirmar-retiro).
    const ingresoPagado = gananciaEfectivo + parseFloat(fondo?.total_pagado_historico || 0);
    // Deuda con la plataforma (pedido asignado no entregado que se reembolsó
    // al cliente): "por pagar" la NETEA y puede quedar negativo — el
    // repartidor debe más de lo que tiene pendiente de cobro.
    const saldoPorCobrar = parseFloat(fondo?.saldo_por_cobrar || 0);

    const pedidosCalificados = await Pedido.count({
      where: { repartidor_id: repartidor.id, calificacion_repartidor: { [Op.not]: null } },
    });

    res.json({
      ok: true,
      data: {
        pedidos_completados: entregados.length,
        total_pedidos:       entregados.length,
        ganancias_envios:    totalEnvios,
        propinas_cobradas:   totalPropinas,
        total_ganado:        ingresoGenerado,
        ingreso_generado:    ingresoGenerado,
        ingreso_pagado:      ingresoPagado,
        ingreso_por_pagar:   Math.max(0, ingresoGenerado - ingresoPagado) - saldoPorCobrar,
        fondo_efectivo:      parseFloat(fondo?.monto_disponible || 0),
        por_depositar:       porDepositar,
        retiro_pendiente:    !!fondo?.retiro_pendiente,
        // Deuda con la plataforma por pedidos asignados no entregados que
        // hubo que reembolsar — se descuenta de los próximos retiros.
        saldo_por_cobrar:    parseFloat(fondo?.saldo_por_cobrar || 0),
        pedidos_recientes:   entregados.slice(0, 30),
        // Reputación — baja permanente automática si promedio < 3★ en 6+ pedidos
        calificacion_promedio: parseFloat(repartidor.calificacion_promedio || 0),
        pedidos_calificados:   pedidosCalificados,
        calificacion_min:      CALIFICACION_MIN_PROMEDIO,
        calificaciones_min_para_baja: CALIFICACIONES_MIN_PARA_BAJA,
      },
    });
  } catch (error) {
    console.error('Error en ganancias repartidor:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener ganancias.' });
  }
};

// Ganancias de pedidos con tarjeta/MP entregados y aún no conciliados —
// es lo que un repartidor tiene "por cobrar" del corte semanal.
const calcularPorDepositarRepartidor = async (repartidorId) => {
  const entregados = await Pedido.findAll({
    where: { repartidor_id: repartidorId, estado: 'entregado', metodo_pago: { [Op.ne]: 'efectivo' } },
    attributes: ['id'],
  });
  const ids = entregados.map((p) => p.id);
  if (ids.length === 0) return { total: 0, ledgers: [] };

  // Solo filas SIN reservar por otra liquidación aún pendiente de confirmar.
  const ledgers = await LedgerConciliacion.findAll({
    where: { pedido_id: { [Op.in]: ids }, conciliado_repartidor: false, liquidacion_repartidor_id: null },
  });
  // Neto de la porción del repartidor: su pago menos su parte prorrateada
  // de la comisión de MP de cada transacción.
  const total = ledgers.reduce((s, l) => s + parseFloat(l.pago_repartidor || 0) - parseFloat(l.fee_mp_repartidor || 0), 0);
  return { total, ledgers };
};

// Reserva atómica de filas del ledger dentro de una nueva Liquidacion
// 'pendiente' — compartida entre solicitarDeposito y retiroDiario. No marca
// conciliado_repartidor: eso solo pasa cuando un admin confirma el depósito
// real (POST /api/admin/liquidaciones/:id/confirmar o /confirmar-retiro).
const reservarLedgersRepartidor = async ({ repartidorId, ledgers, montoCalculado, tipo }) => {
  const liquidacionId = crypto.randomUUID();
  const idsIntentados = ledgers.map((l) => l.id);
  if (idsIntentados.length === 0) {
    await Liquidacion.create({
      id: liquidacionId, entidad_tipo: 'repartidor', entidad_id: repartidorId, tipo,
      estado: 'pendiente', monto_calculado: montoCalculado, pedidos_liquidados: 0, ledger_ids: [],
    });
    return { ok: true, liquidacionId };
  }
  const [reservados] = await LedgerConciliacion.update(
    { liquidacion_repartidor_id: liquidacionId },
    { where: { id: { [Op.in]: idsIntentados }, conciliado_repartidor: false, liquidacion_repartidor_id: null } }
  );
  if (reservados !== idsIntentados.length) {
    if (reservados > 0) {
      await LedgerConciliacion.update({ liquidacion_repartidor_id: null }, { where: { liquidacion_repartidor_id: liquidacionId } });
    }
    return { ok: false };
  }
  await Liquidacion.create({
    id: liquidacionId, entidad_tipo: 'repartidor', entidad_id: repartidorId, tipo,
    estado: 'pendiente', monto_calculado: montoCalculado, pedidos_liquidados: ledgers.length, ledger_ids: idsIntentados,
  });
  return { ok: true, liquidacionId };
};

// ─── POST /api/repartidores/solicitar-deposito ────────────
// Pago semanal (viernes) SIN comisión — incluye fondo de efectivo/propinas
// más las ganancias de pedidos con tarjeta aún no conciliadas.
const solicitarDeposito = async (req, res) => {
  try {
    const repartidor = await Repartidor.findOne({
      where: { usuario_id: req.usuario.id },
      include: [{ model: Usuario, as: 'usuario', attributes: ['nombre', 'telefono'] }],
    });
    if (!repartidor) return res.status(404).json({ ok: false, mensaje: 'Perfil no encontrado.' });

    const fondo = await FondoRepartidor.findOne({ where: { repartidor_id: repartidor.id } });

    // Mismo candado que retiroDiario — evita doble-envío (doble-tap, reintento
    // de red) que generaría dos alertas de pago por el mismo dinero.
    if (fondo?.retiro_pendiente) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Ya tienes un pago en proceso. Espera a que se transfiera antes de solicitar otro.',
      });
    }

    const montoFondo = parseFloat(fondo?.monto_disponible || 0);
    const { total: montoTarjeta, ledgers } = await calcularPorDepositarRepartidor(repartidor.id);
    const bruto = montoFondo + montoTarjeta;

    if (bruto <= 0) {
      return res.status(400).json({ ok: false, mensaje: 'No tienes saldo disponible para solicitar depósito.' });
    }

    // Neteo del saldo por cobrar (pedidos asignados no entregados que se
    // reembolsaron al cliente): se descuenta ANTES de pagar.
    const saldoPorCobrar = parseFloat(fondo?.saldo_por_cobrar || 0);
    const recuperado = Math.min(bruto, saldoPorCobrar);
    const monto = bruto - recuperado;

    if (monto <= 0) {
      return res.status(400).json({
        ok: false,
        mensaje: `Tu saldo por cobrar con la plataforma ($${saldoPorCobrar.toFixed(2)}) es mayor o igual a tus ganancias disponibles ($${bruto.toFixed(2)}). Se seguirá descontando de tus próximas entregas.`,
      });
    }

    // Reserva atómica de la porción de tarjeta ANTES de comprometer el fondo
    // — si la reserva falla por carrera (doble-tap), no se toca el fondo.
    const reserva = await reservarLedgersRepartidor({
      repartidorId: repartidor.id, ledgers, montoCalculado: montoTarjeta, tipo: 'corte_semanal',
    });
    if (!reserva.ok) {
      return res.status(409).json({ ok: false, mensaje: 'Ya se solicitó un depósito para parte de este saldo. Intenta de nuevo en unos segundos.' });
    }

    if (fondo) await fondo.update({ monto_disponible: 0, retiro_pendiente: true, monto_pendiente_confirmar: monto, saldo_por_cobrar: saldoPorCobrar - recuperado });
    else await FondoRepartidor.create({ repartidor_id: repartidor.id, monto_disponible: 0, retiro_pendiente: true, monto_pendiente_confirmar: monto });

    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminChatId) {
      tg.enviar(adminChatId,
        `💰 <b>Solicitud de depósito semanal</b>\n` +
        `Repartidor: ${repartidor.usuario?.nombre}\n` +
        `Teléfono: ${repartidor.usuario?.telefono || 'N/A'}\n` +
        `Efectivo/propinas: $${montoFondo.toFixed(2)} | Tarjeta: $${montoTarjeta.toFixed(2)}\n` +
        (recuperado > 0 ? `Recuperado de saldo por cobrar: -$${recuperado.toFixed(2)} (resta $${(saldoPorCobrar - recuperado).toFixed(2)})\n` : '') +
        `Monto total: $${monto.toFixed(2)} MXN\n` +
        `ID repartidor: ${repartidor.id} | ID liquidación: ${reserva.liquidacionId}\n` +
        `Confirma con POST /api/admin/repartidores/${repartidor.id}/confirmar-retiro`
      ).catch(() => {});
    }
    console.log(`[deposito] Solicitud de ${repartidor.usuario?.nombre} (${repartidor.id}) por $${monto}`);

    res.json({
      ok: true,
      mensaje: 'Solicitud enviada. Procesaremos tu depósito en 24-48 horas hábiles.',
      data: { monto_solicitado: monto, fondo_efectivo: montoFondo, tarjeta: montoTarjeta },
    });
  } catch (error) {
    console.error('Error en solicitarDeposito:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al solicitar depósito.' });
  }
};

// ─── POST /api/repartidores/retiro-diario ─────────────────
// Retiro inmediato con fee (los viernes es gratis: usar solicitarDeposito).
// Incluye fondo de efectivo/propinas MÁS ganancias de tarjeta no conciliadas.
const retiroDiario = async (req, res) => {
  try {
    const { PCT_DESCUENTO_PAGO_DIARIO } = require('../config/precios');

    const repartidor = await Repartidor.findOne({
      where: { usuario_id: req.usuario.id },
      include: [{ model: Usuario, as: 'usuario', attributes: ['nombre', 'telefono'] }],
    });
    if (!repartidor) return res.status(404).json({ ok: false, mensaje: 'Perfil no encontrado.' });

    const fondo = await FondoRepartidor.findOne({ where: { repartidor_id: repartidor.id } });
    const montoFondo = parseFloat(fondo?.monto_disponible || 0);
    const { total: montoTarjeta, ledgers } = await calcularPorDepositarRepartidor(repartidor.id);
    // Neteo del saldo por cobrar (pedidos asignados no entregados que se
    // reembolsaron al cliente) ANTES del fee.
    const saldoPorCobrar = parseFloat(fondo?.saldo_por_cobrar || 0);
    const recuperado = Math.min(montoFondo + montoTarjeta, saldoPorCobrar);
    const disponible = montoFondo + montoTarjeta - recuperado;
    // Pago diario anticipado: 5% de descuento sobre el saldo pendiente
    // (modelo 2026-07-23 — reemplaza el fee fijo de $10). Viernes gratis.
    const feeDiario = Math.round(disponible * PCT_DESCUENTO_PAGO_DIARIO * 100) / 100;
    const neto      = Math.round((disponible - feeDiario) * 100) / 100;

    if (neto <= 0) {
      return res.status(400).json({
        ok: false,
        mensaje: recuperado > 0
          ? `Tras descontar tu saldo por cobrar ($${saldoPorCobrar.toFixed(2)}) no te queda saldo suficiente para el retiro. Se seguirá descontando de tus próximas entregas.`
          : `No tienes saldo disponible para el retiro diario. Tienes $${disponible.toFixed(2)} MXN.`,
      });
    }

    if (fondo?.retiro_pendiente) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Ya tienes un retiro en proceso. Espera a que sea transferido antes de solicitar otro.',
      });
    }

    // Reserva atómica de la porción de tarjeta ANTES de comprometer el fondo
    // — si la reserva falla por carrera (doble-tap), no se toca el fondo.
    // Solo se marca conciliado_repartidor cuando un admin confirme el
    // depósito real (nunca al solo solicitarlo).
    const reserva = await reservarLedgersRepartidor({
      repartidorId: repartidor.id, ledgers, montoCalculado: neto, tipo: 'retiro_diario',
    });
    if (!reserva.ok) {
      return res.status(409).json({ ok: false, mensaje: 'Ya se solicitó un retiro para parte de este saldo. Intenta de nuevo en unos segundos.' });
    }

    // Descontar el saldo y marcar retiro pendiente (monto_pendiente_confirmar
    // = neto, lo que realmente recibirá el repartidor — el fee se lo queda
    // la plataforma, no cuenta como "pagado")
    if (fondo) await fondo.update({ monto_disponible: 0, retiro_pendiente: true, monto_pendiente_confirmar: neto, saldo_por_cobrar: saldoPorCobrar - recuperado });
    else await FondoRepartidor.create({ repartidor_id: repartidor.id, monto_disponible: 0, retiro_pendiente: true, monto_pendiente_confirmar: neto });

    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminChatId) {
      tg.enviar(adminChatId,
        `⚡ <b>Retiro diario solicitado</b>\n` +
        `Repartidor: ${repartidor.usuario?.nombre}\n` +
        `Efectivo/propinas: $${montoFondo.toFixed(2)} | Tarjeta: $${montoTarjeta.toFixed(2)}\n` +
        (recuperado > 0 ? `Recuperado de saldo por cobrar: -$${recuperado.toFixed(2)} (resta $${(saldoPorCobrar - recuperado).toFixed(2)})\n` : '') +
        `Disponible: $${disponible.toFixed(2)} | Descuento 5%: $${feeDiario.toFixed(2)} | Neto: $${neto.toFixed(2)} MXN\n` +
        `ID repartidor: ${repartidor.id} | ID liquidación: ${reserva.liquidacionId}\n` +
        `Confirma con POST /api/admin/repartidores/${repartidor.id}/confirmar-retiro`
      ).catch(() => {});
    }

    res.json({
      ok: true,
      mensaje: `Retiro solicitado ($${neto.toFixed(2)} MXN, con 5% de descuento por pago diario). Pendiente de confirmación — lo recibirás por SPEI.`,
      data: { liquidacion_id: reserva.liquidacionId, disponible, fee: feeDiario, neto },
    });
  } catch (error) {
    console.error('Error retiroDiario:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al procesar el retiro.' });
  }
};

module.exports = {
  activarModo,
  actualizarPerfil,
  miPerfil,
  subirFoto,
  enviarARevision,
  conectarse,
  crearPerfil,
  actualizarDisponibilidad,
  misEntregas,
  pedidosDisponibles,
  aceptarPedido,
  miRuta,
  ganancias,
  solicitarDeposito,
  retiroDiario,
};
