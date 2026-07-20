/**
 * Controlador del Panel de Administracion (BACKOFFICE)
 *
 * Endpoints que usa el panel web /admin para que el equipo de VoyCorriendo
 * pueda aprobar/rechazar repartidores y negocios, y administrar cuentas.
 *
 * Todas las rutas requieren middleware: proteger + restringirA('admin').
 */
const { Op, fn, col, literal } = require('sequelize');
const { Usuario, Repartidor, Negocio, Pedido, PlatformRevenue, LedgerConciliacion, FondoRepartidor } = require('../models');
const { obtenerUrlFirmada } = require('../services/storage.service');
const { logAdmin } = require('../utils/audit');

const BUCKET_REPARTIDORES = 'documentos-repartidores';
const BUCKET_NEGOCIOS     = 'documentos-negocios';

// ─── GET /api/admin/dashboard ───────────────────────────────
// Numeros generales para la pantalla principal del admin.
const dashboard = async (req, res) => {
  try {
    const estadosPendientes = { [Op.in]: ['pendiente', 'en_revision'] };
    const hoy = new Date(new Date().setHours(0, 0, 0, 0));

    const [
      totalUsuarios,
      repartidoresAprobados,
      repartidoresConectados,
      negociosAprobados,
      negociosAbiertos,
      pedidosHoy,
      negocios_pendientes,
      repartidores_pendientes,
    ] = await Promise.all([
      Usuario.count(),
      Repartidor.count({ where: { verificacion_estado: 'aprobado' } }),
      Repartidor.count({ where: { conectado: true } }),
      Negocio.count({ where: { verificacion_estado: 'aprobado' } }),
      Negocio.count({ where: { abierto_ahora: true, verificacion_estado: 'aprobado' } }),
      Pedido.count({ where: { creado_en: { [Op.gte]: hoy } } }),
      Negocio.findAll({
        where: { verificacion_estado: estadosPendientes },
        include: [{ model: Usuario, as: 'dueno', attributes: ['id', 'nombre', 'apellido', 'telefono', 'email'] }],
        order: [['enviado_revision_en', 'ASC NULLS LAST']],
        attributes: [
          'id', 'nombre', 'categoria', 'telefono', 'direccion',
          'verificacion_estado', 'verificacion_nota',
          'enviado_revision_en', 'resolucion_en', 'creado_en',
        ],
      }),
      Repartidor.findAll({
        where: { verificacion_estado: estadosPendientes },
        include: [{ model: Usuario, as: 'usuario', attributes: ['id', 'nombre', 'apellido', 'telefono', 'email'] }],
        order: [['enviado_revision_en', 'ASC NULLS LAST']],
        attributes: [
          'id', 'tipo_vehiculo', 'placa_vehiculo', 'verificacion_estado', 'verificacion_nota',
          'enviado_revision_en', 'resolucion_en', 'creado_en',
        ],
      }),
    ]);

    res.json({
      ok: true,
      data: {
        totalUsuarios,
        repartidores: {
          pendientes: repartidores_pendientes.length,
          aprobados:  repartidoresAprobados,
          conectados: repartidoresConectados,
        },
        negocios: {
          pendientes: negocios_pendientes.length,
          aprobados:  negociosAprobados,
          abiertos:   negociosAbiertos,
        },
        pedidosHoy,
        negocios_pendientes,
        repartidores_pendientes,
      },
    });
  } catch (e) {
    console.error('Error dashboard admin:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al cargar el dashboard.' });
  }
};

// ─── GET /api/admin/repartidores?estado=pendiente ────────────
const listarRepartidores = async (req, res) => {
  try {
    const { estado } = req.query;
    const where = {};
    if (estado) {
      if (estado === 'pendiente') {
        where.verificacion_estado = { [Op.in]: ['pendiente', 'en_revision'] };
      } else {
        where.verificacion_estado = estado;
      }
    }

    const repartidores = await Repartidor.findAll({
      where,
      include: [{
        model: Usuario,
        as: 'usuario',
        attributes: ['id', 'nombre', 'apellido', 'telefono', 'email'],
      }],
      order: [['actualizado_en', 'DESC']],
    });

    res.json({ ok: true, data: { repartidores } });
  } catch (e) {
    console.error('Error listar repartidores admin:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al listar repartidores.' });
  }
};

// ─── GET /api/admin/repartidores/:id ────────────────────────
// Devuelve el detalle COMPLETO + URLs firmadas (validas 1 hora).
const obtenerRepartidor = async (req, res) => {
  try {
    const { id } = req.params;
    const r = await Repartidor.findByPk(id, {
      include: [{ model: Usuario, as: 'usuario' }],
    });
    if (!r) return res.status(404).json({ ok: false, mensaje: 'Repartidor no encontrado.' });

    // Firmamos las URLs de los documentos para poder verlos en el panel
    const [ineFrente, ineReverso, licencia, tarjeta] = await Promise.all([
      obtenerUrlFirmada(BUCKET_REPARTIDORES, r.foto_ine_frente),
      obtenerUrlFirmada(BUCKET_REPARTIDORES, r.foto_ine_reverso),
      obtenerUrlFirmada(BUCKET_REPARTIDORES, r.foto_licencia),
      obtenerUrlFirmada(BUCKET_REPARTIDORES, r.foto_tarjeta_circulacion),
    ]);

    const rData = r.toJSON();
    delete rData.clabe_bancaria; // cifrada AES pero no necesaria en esta vista
    res.json({
      ok: true,
      data: {
        repartidor: {
          ...rData,
          documentos_firmados: {
            ine_frente: ineFrente,
            ine_reverso: ineReverso,
            licencia,
            tarjeta_circulacion: tarjeta,
          },
        },
      },
    });
  } catch (e) {
    console.error('Error obtener repartidor admin:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener repartidor.' });
  }
};

// ─── PATCH /api/admin/repartidores/:id/aprobar ─────────────
const aprobarRepartidor = async (req, res) => {
  try {
    const { id } = req.params;
    const r = await Repartidor.findByPk(id);
    if (!r) return res.status(404).json({ ok: false, mensaje: 'Repartidor no encontrado.' });
    const estadoAntes = { verificacion_estado: r.verificacion_estado };
    r.verificacion_estado = 'aprobado';
    r.verificacion_nota   = null;
    r.antecedentes_ok     = true;
    r.resolucion_en       = new Date();
    await r.save();
    logAdmin({ adminId: req.usuario.id, accion: 'aprobar_repartidor', entidadTipo: 'repartidor', entidadId: r.id, estadoAntes, estadoDespues: { verificacion_estado: 'aprobado' }, ip: req.ip });
    res.json({ ok: true, data: { repartidor: r } });
  } catch (e) {
    console.error('Error aprobar repartidor:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al aprobar.' });
  }
};

// ─── PATCH /api/admin/repartidores/:id/rechazar ────────────
const rechazarRepartidor = async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;
    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ ok: false, mensaje: 'Da un motivo claro (minimo 5 caracteres).' });
    }
    const r = await Repartidor.findByPk(id);
    if (!r) return res.status(404).json({ ok: false, mensaje: 'Repartidor no encontrado.' });
    const estadoAntes = { verificacion_estado: r.verificacion_estado };
    r.verificacion_estado = 'rechazado';
    r.verificacion_nota   = motivo;
    r.resolucion_en       = new Date();
    await r.save();
    logAdmin({ adminId: req.usuario.id, accion: 'rechazar_repartidor', entidadTipo: 'repartidor', entidadId: r.id, estadoAntes, estadoDespues: { verificacion_estado: 'rechazado', motivo }, ip: req.ip });
    res.json({ ok: true, data: { repartidor: r } });
  } catch (e) {
    console.error('Error rechazar repartidor:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al rechazar.' });
  }
};

// ─── PATCH /api/admin/repartidores/:id/cuenta ─────────────
// Cambia estado_cuenta: normal | observacion | probation | suspendido | bloqueado
const cambiarEstadoCuentaRepartidor = async (req, res) => {
  try {
    const { id } = req.params;
    const { estado_cuenta, motivo } = req.body;
    const validos = ['normal', 'observacion', 'probation', 'suspendido', 'bloqueado'];
    if (!validos.includes(estado_cuenta)) {
      return res.status(400).json({ ok: false, mensaje: 'Estado de cuenta invalido.' });
    }
    const r = await Repartidor.findByPk(id);
    if (!r) return res.status(404).json({ ok: false, mensaje: 'Repartidor no encontrado.' });
    const estadoAntes = { estado_cuenta: r.estado_cuenta };
    r.estado_cuenta = estado_cuenta;
    r.estado_motivo = motivo || null;
    if (estado_cuenta === 'suspendido' || estado_cuenta === 'bloqueado') {
      r.conectado = false;
      r.disponible = false;
    }
    await r.save();
    logAdmin({ adminId: req.usuario.id, accion: 'cambiar_cuenta_repartidor', entidadTipo: 'repartidor', entidadId: r.id, estadoAntes, estadoDespues: { estado_cuenta, motivo }, ip: req.ip });
    res.json({ ok: true, data: { repartidor: r } });
  } catch (e) {
    console.error('Error cambiar estado cuenta repartidor:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al cambiar estado.' });
  }
};

// ─── GET /api/admin/negocios?estado=pendiente ────────────────
const listarNegocios = async (req, res) => {
  try {
    const { estado } = req.query;
    const where = {};
    if (estado) {
      if (estado === 'pendiente') {
        where.verificacion_estado = { [Op.in]: ['pendiente', 'en_revision'] };
      } else {
        where.verificacion_estado = estado;
      }
    }

    const negocios = await Negocio.findAll({
      where,
      include: [{
        model: Usuario,
        as: 'dueno',
        attributes: ['id', 'nombre', 'apellido', 'telefono', 'email'],
      }],
      order: [['actualizado_en', 'DESC']],
    });

    res.json({ ok: true, data: { negocios } });
  } catch (e) {
    console.error('Error listar negocios admin:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al listar negocios.' });
  }
};

// ─── GET /api/admin/negocios/:id ────────────────────────────
const obtenerNegocio = async (req, res) => {
  try {
    const { id } = req.params;
    const n = await Negocio.findByPk(id, {
      include: [{ model: Usuario, as: 'dueno' }],
    });
    if (!n) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });

    const [fotoLocal, fotoPortada, comprobante, ine, rfc] = await Promise.all([
      obtenerUrlFirmada(BUCKET_NEGOCIOS, n.foto_local),
      obtenerUrlFirmada(BUCKET_NEGOCIOS, n.foto_portada),
      obtenerUrlFirmada(BUCKET_NEGOCIOS, n.comprobante_domicilio),
      obtenerUrlFirmada(BUCKET_NEGOCIOS, n.documento_ine_dueno),
      obtenerUrlFirmada(BUCKET_NEGOCIOS, n.documento_rfc),
    ]);

    res.json({
      ok: true,
      data: {
        negocio: {
          ...n.toJSON(),
          documentos_firmados: {
            foto_local: fotoLocal,
            foto_portada: fotoPortada,
            comprobante_domicilio: comprobante,
            documento_ine_dueno: ine,
            documento_rfc: rfc,
          },
        },
      },
    });
  } catch (e) {
    console.error('Error obtener negocio admin:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener negocio.' });
  }
};

// ─── PATCH /api/admin/negocios/:id/aprobar ─────────────────
const aprobarNegocio = async (req, res) => {
  try {
    const { id } = req.params;
    const n = await Negocio.findByPk(id);
    if (!n) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    const estadoAntes = { verificacion_estado: n.verificacion_estado, activo: n.activo };
    n.verificacion_estado = 'aprobado';
    n.verificacion_nota   = null;
    n.activo              = true;
    n.resolucion_en       = new Date();
    await n.save();
    logAdmin({ adminId: req.usuario.id, accion: 'aprobar_negocio', entidadTipo: 'negocio', entidadId: n.id, estadoAntes, estadoDespues: { verificacion_estado: 'aprobado', activo: true }, ip: req.ip });
    res.json({ ok: true, data: { negocio: n } });
  } catch (e) {
    console.error('Error aprobar negocio:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al aprobar.' });
  }
};

// ─── PATCH /api/admin/negocios/:id/rechazar ────────────────
const rechazarNegocio = async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;
    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ ok: false, mensaje: 'Da un motivo claro (minimo 5 caracteres).' });
    }
    const n = await Negocio.findByPk(id);
    if (!n) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    const estadoAntes = { verificacion_estado: n.verificacion_estado, activo: n.activo };
    n.verificacion_estado = 'rechazado';
    n.verificacion_nota   = motivo;
    n.activo              = false;
    n.resolucion_en       = new Date();
    await n.save();
    logAdmin({ adminId: req.usuario.id, accion: 'rechazar_negocio', entidadTipo: 'negocio', entidadId: n.id, estadoAntes, estadoDespues: { verificacion_estado: 'rechazado', motivo }, ip: req.ip });
    res.json({ ok: true, data: { negocio: n } });
  } catch (e) {
    console.error('Error rechazar negocio:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al rechazar.' });
  }
};

// ─── PATCH /api/admin/negocios/:id/cuenta ─────────────────
const cambiarEstadoCuentaNegocio = async (req, res) => {
  try {
    const { id } = req.params;
    const { estado_cuenta, motivo } = req.body;
    const validos = ['normal', 'observacion', 'probation', 'suspendido', 'bloqueado'];
    if (!validos.includes(estado_cuenta)) {
      return res.status(400).json({ ok: false, mensaje: 'Estado de cuenta invalido.' });
    }
    const n = await Negocio.findByPk(id);
    if (!n) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    const estadoAntes = { estado_cuenta: n.estado_cuenta };
    n.estado_cuenta = estado_cuenta;
    n.estado_motivo = motivo || null;
    if (estado_cuenta === 'suspendido' || estado_cuenta === 'bloqueado') {
      n.abierto_ahora = false;
    }
    await n.save();
    logAdmin({ adminId: req.usuario.id, accion: 'cambiar_cuenta_negocio', entidadTipo: 'negocio', entidadId: n.id, estadoAntes, estadoDespues: { estado_cuenta, motivo }, ip: req.ip });
    res.json({ ok: true, data: { negocio: n } });
  } catch (e) {
    console.error('Error cambiar estado cuenta negocio:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al cambiar estado.' });
  }
};

// ─── GET /api/admin/usuarios ────────────────────────────────
const listarUsuarios = async (req, res) => {
  try {
    const { buscar } = req.query;
    const where = {};
    if (buscar) {
      where[Op.or] = [
        { nombre:   { [Op.iLike]: `%${buscar}%` } },
        { apellido: { [Op.iLike]: `%${buscar}%` } },
        { telefono: { [Op.iLike]: `%${buscar}%` } },
        { email:    { [Op.iLike]: `%${buscar}%` } },
      ];
    }
    const usuarios = await Usuario.findAll({
      where,
      attributes: ['id', 'nombre', 'apellido', 'telefono', 'email', 'rol', 'modo_activo', 'estado', 'creado_en'],
      order: [['creado_en', 'DESC']],
      limit: 200,
    });
    res.json({ ok: true, data: { usuarios } });
  } catch (e) {
    console.error('Error listar usuarios admin:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al listar usuarios.' });
  }
};

// ─── POST /api/admin/negocios/:id/confirmar-pago ─────────────
// El admin verifica la transferencia SPEI del restaurante y libera la deuda.
const confirmarPagoDeuda = async (req, res) => {
  try {
    const { id } = req.params;
    const negocio = await Negocio.findByPk(id);
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });

    const deudaAntes = parseFloat(negocio.deuda_plataforma || 0);
    negocio.deuda_plataforma  = 0;
    negocio.bloqueado_por_deuda = false;
    if (negocio.estado_cuenta === 'bloqueado') {
      negocio.estado_cuenta = 'normal';
      negocio.estado_motivo = null;
    }
    await negocio.save();

    logAdmin({
      adminId: req.usuario.id, accion: 'confirmar_pago_deuda', entidadTipo: 'negocio',
      entidadId: negocio.id, estadoAntes: { deuda: deudaAntes },
      estadoDespues: { deuda: 0 }, ip: req.ip,
    });

    res.json({ ok: true, mensaje: `Deuda de $${deudaAntes.toFixed(2)} MXN liquidada. Negocio desbloqueado.`, data: { negocio } });
  } catch (e) {
    console.error('Error confirmarPagoDeuda:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al confirmar el pago.' });
  }
};

// ─── POST /api/admin/negocios/:id/liquidar-semanal ───────────
// El admin marca como pagadas (corte del viernes) las ganancias de
// tarjeta/MP de un negocio tras enviar la transferencia SPEI real.
const liquidarSemanalNegocio = async (req, res) => {
  try {
    const { id } = req.params;
    const negocio = await Negocio.findByPk(id);
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });

    const pedidos = await Pedido.findAll({
      where: { negocio_id: id, estado: 'entregado', metodo_pago: { [Op.ne]: 'efectivo' } },
      attributes: ['id'],
    });
    const ids = pedidos.map((p) => p.id);
    const ledgers = ids.length > 0
      ? await LedgerConciliacion.findAll({ where: { pedido_id: { [Op.in]: ids }, conciliado: false } })
      : [];

    const { COMISION_FLAT } = require('../config/precios');
    const monto = Math.max(0, ledgers.reduce(
      (s, l) => s + parseFloat(l.subtotal_productos || 0) - COMISION_FLAT, 0
    ));

    if (ledgers.length > 0) {
      await LedgerConciliacion.update(
        { conciliado: true, conciliado_en: new Date() },
        { where: { id: { [Op.in]: ledgers.map((l) => l.id) }, conciliado: false } }
      );
    }

    logAdmin({
      adminId: req.usuario.id, accion: 'liquidar_semanal_negocio', entidadTipo: 'negocio',
      entidadId: negocio.id, estadoAntes: { pendiente: monto },
      estadoDespues: { conciliado: true }, ip: req.ip,
    });

    res.json({
      ok: true,
      mensaje: `Corte semanal liquidado: $${monto.toFixed(2)} MXN marcado como pagado.`,
      data: { negocio_id: id, monto_liquidado: monto, pedidos_conciliados: ledgers.length },
    });
  } catch (e) {
    console.error('Error liquidarSemanalNegocio:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al liquidar el corte semanal.' });
  }
};

// ─── PATCH /api/admin/pedidos/:id/confirmar-pago ─────────────
// El admin verifica que la transferencia SPEI del cliente (Voy Store®)
// realmente llegó y captura el pago — sin esto, un pedido por transferencia
// nunca podría avanzar más allá de 'autorizado' porque nada más lo hace.
const confirmarPagoPedido = async (req, res) => {
  try {
    const { id } = req.params;
    const pedido = await Pedido.findByPk(id);
    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });
    if (pedido.metodo_pago !== 'transferencia') {
      return res.status(400).json({ ok: false, mensaje: 'Este pedido no es por transferencia — su pago se confirma automáticamente.' });
    }
    if (pedido.pago_estado === 'capturado') {
      return res.status(400).json({ ok: false, mensaje: 'Este pedido ya tenía el pago confirmado.' });
    }

    pedido.pago_estado = 'capturado';
    await pedido.save();

    logAdmin({
      adminId: req.usuario.id, accion: 'confirmar_pago_pedido', entidadTipo: 'pedido',
      entidadId: pedido.id, estadoAntes: { pago_estado: 'autorizado' },
      estadoDespues: { pago_estado: 'capturado' }, ip: req.ip,
    });

    res.json({ ok: true, mensaje: `Pago de ${pedido.numero} confirmado. El negocio ya puede recibirlo.`, data: { pedido } });
  } catch (e) {
    console.error('Error confirmarPagoPedido:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al confirmar el pago.' });
  }
};

// ─── POST /api/admin/repartidores/:id/confirmar-retiro ───────
// El admin confirma que ya transfirió el retiro diario/semanal pendiente —
// sin esto, retiro_pendiente=true se queda para siempre y el repartidor
// jamás puede volver a pedir un retiro.
const confirmarRetiroRepartidor = async (req, res) => {
  try {
    const { id } = req.params;
    const fondo = await FondoRepartidor.findOne({ where: { repartidor_id: id } });
    if (!fondo) return res.status(404).json({ ok: false, mensaje: 'Repartidor sin fondo registrado.' });
    if (!fondo.retiro_pendiente) {
      return res.status(400).json({ ok: false, mensaje: 'Este repartidor no tiene ningún retiro pendiente.' });
    }

    const montoConfirmado = parseFloat(fondo.monto_pendiente_confirmar || 0);
    await fondo.update({
      retiro_pendiente: false,
      monto_pendiente_confirmar: 0,
      total_pagado_historico: parseFloat(fondo.total_pagado_historico || 0) + montoConfirmado,
    });

    logAdmin({
      adminId: req.usuario.id, accion: 'confirmar_retiro_repartidor', entidadTipo: 'repartidor',
      entidadId: id, estadoAntes: { retiro_pendiente: true, monto: montoConfirmado },
      estadoDespues: { retiro_pendiente: false }, ip: req.ip,
    });

    res.json({ ok: true, mensaje: `Retiro de $${montoConfirmado.toFixed(2)} MXN marcado como transferido. El repartidor ya puede solicitar otro.` });
  } catch (e) {
    console.error('Error confirmarRetiroRepartidor:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al confirmar el retiro.' });
  }
};

module.exports = {
  dashboard,
  // Repartidores
  listarRepartidores,
  obtenerRepartidor,
  aprobarRepartidor,
  rechazarRepartidor,
  cambiarEstadoCuentaRepartidor,
  // Negocios
  listarNegocios,
  obtenerNegocio,
  aprobarNegocio,
  rechazarNegocio,
  cambiarEstadoCuentaNegocio,
  confirmarPagoDeuda,
  liquidarSemanalNegocio,
  confirmarPagoPedido,
  confirmarRetiroRepartidor,
  // Usuarios
  listarUsuarios,
  // Revenue
  revenueReport,
};

// ─── GET /api/admin/revenue ─────────────────────────────────────
// Query params: periodo=hoy|semana|mes|rango  desde=YYYY-MM-DD  hasta=YYYY-MM-DD
async function revenueReport(req, res) {
  try {
    const { periodo = 'semana', desde, hasta } = req.query;

    const ahora = new Date();
    let fechaDesde, fechaHasta;

    if (periodo === 'hoy') {
      fechaDesde = new Date(ahora); fechaDesde.setHours(0, 0, 0, 0);
      fechaHasta = new Date(ahora); fechaHasta.setHours(23, 59, 59, 999);
    } else if (periodo === 'mes') {
      fechaDesde = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
      fechaHasta = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0, 23, 59, 59);
    } else if (periodo === 'rango' && desde && hasta) {
      if (isNaN(new Date(desde)) || isNaN(new Date(hasta))) {
        return res.status(400).json({ ok: false, mensaje: 'Fechas inválidas. Usa formato YYYY-MM-DD.' });
      }
      fechaDesde = new Date(desde);
      fechaHasta = new Date(hasta); fechaHasta.setHours(23, 59, 59, 999);
    } else {
      // semana (default)
      fechaDesde = new Date(ahora); fechaDesde.setDate(ahora.getDate() - 6); fechaDesde.setHours(0, 0, 0, 0);
      fechaHasta = new Date(ahora); fechaHasta.setHours(23, 59, 59, 999);
    }

    const where = { created_at: { [Op.between]: [fechaDesde, fechaHasta] } };

    // ── Totales del período ──────────────────────────────────
    const [filas, porTier, pedidosMeta] = await Promise.all([
      PlatformRevenue.findAll({
        where,
        attributes: [
          [fn('SUM', col('token_value')),      'total_tokens'],
          [fn('SUM', col('client_fee')),        'total_fees'],
          [fn('SUM', col('driver_payout')),     'total_payouts'],
          [fn('SUM', col('transaction_cost')),  'total_transacciones'],
          [fn('SUM', col('gateway_fee')),       'total_gateway'],
          [fn('SUM', col('net_revenue')),       'total_neto'],
          [fn('COUNT', col('id')),              'total_entregas'],
        ],
      }),

      // Desglose por tier
      PlatformRevenue.findAll({
        where,
        attributes: [
          'tier',
          [fn('SUM', col('net_revenue')), 'neto'],
          [fn('COUNT', col('id')),        'entregas'],
        ],
        group: ['tier'],
      }),

      // Pedidos del período (para express vs standard)
      Pedido.findAll({
        where: { creado_en: { [Op.between]: [fechaDesde, fechaHasta] } },
        attributes: [
          'tipo_envio',
          [fn('COUNT', col('id')), 'total'],
          [fn('SUM', col('total')), 'gmv'],
        ],
        group: ['tipo_envio'],
      }),
    ]);

    // ── Revenue por día (para gráfica) ───────────────────────
    const porDia = await PlatformRevenue.findAll({
      where,
      attributes: [
        [fn('DATE', col('created_at')), 'fecha'],
        [fn('SUM', col('net_revenue')), 'neto'],
        [fn('COUNT', col('id')),        'entregas'],
      ],
      group: [fn('DATE', col('created_at'))],
      order: [[fn('DATE', col('created_at')), 'ASC']],
    });

    // ── Cartera: deudas de restaurantes (modelo flat $35) ────
    const negociosConDeuda = await Negocio.findAll({
      where: { deuda_plataforma: { [Op.gt]: 0 } },
      attributes: ['id', 'nombre', 'deuda_plataforma', 'bloqueado_por_deuda', 'estado_cuenta'],
      order: [['deuda_plataforma', 'DESC']],
    });
    const deudaTotalRestaurantes = negociosConDeuda.reduce((s, n) => s + parseFloat(n.deuda_plataforma || 0), 0);
    const negociosBloqueados     = negociosConDeuda.filter(n => n.bloqueado_por_deuda).length;

    // ── Por pagar el próximo viernes ─────────────────────────
    // A restaurantes: suma de (subtotal - $35) de pedidos tarjeta no conciliados
    // A repartidores: suma de pago_repartidor de pedidos tarjeta no conciliados
    const [ledgerPendienteTarjeta] = await LedgerConciliacion.findAll({
      where: { metodo_pago: { [Op.ne]: 'efectivo' }, conciliado: false },
      attributes: [
        [fn('SUM', col('subtotal_productos')),  'sum_subtotal'],
        [fn('SUM', col('pago_repartidor')),     'sum_repartidor'],
        [fn('SUM', col('comision_plataforma')), 'sum_comision'],
        [fn('COUNT', col('id')),               'count'],
      ],
    });
    const lp = ledgerPendienteTarjeta?.dataValues || {};
    const porPagarRestaurantes  = Math.max(0, parseFloat(lp.sum_subtotal || 0) - parseFloat(lp.sum_comision || 0));
    const porPagarRepartidores  = parseFloat(lp.sum_repartidor || 0);
    const pedidosTarjetaPendientes = parseInt(lp.count || 0);

    // ── Fees del período desde ledger (fuente de verdad) ─────
    const ledgerPeriodo = await LedgerConciliacion.findAll({
      where: { registrado_en: { [Op.between]: [fechaDesde, fechaHasta] } },
      attributes: [
        [fn('SUM', col('comision_plataforma')), 'fees_total'],
        [fn('COUNT', col('id')),               'entregas'],
      ],
    });
    const lperiodo = ledgerPeriodo[0]?.dataValues || {};

    const totales = filas[0]?.dataValues || {};

    res.json({
      ok: true,
      data: {
        periodo: { desde: fechaDesde, hasta: fechaHasta, tipo: periodo },
        totales: {
          fees_plataforma:    parseFloat(lperiodo.fees_total || 0),
          entregas:           parseInt(lperiodo.entregas || 0),
          // legado PlatformRevenue (mantener para compatibilidad con panel web)
          ingresos_tokens:    parseFloat(totales.total_tokens || 0),
          fees_cliente:       parseFloat(totales.total_fees || 0),
          pagos_repartidores: parseFloat(totales.total_payouts || 0),
          costos_gateway:     parseFloat(totales.total_gateway || 0) + parseFloat(totales.total_transacciones || 0),
          neto:               parseFloat(totales.total_neto || 0),
        },
        cartera: {
          deuda_total_restaurantes: deudaTotalRestaurantes,
          negocios_con_deuda:       negociosConDeuda.length,
          negocios_bloqueados:      negociosBloqueados,
          lista: negociosConDeuda.slice(0, 20).map(n => ({
            id:              n.id,
            nombre:          n.nombre,
            deuda:           parseFloat(n.deuda_plataforma),
            bloqueado:       n.bloqueado_por_deuda,
            estado_cuenta:   n.estado_cuenta,
          })),
        },
        por_pagar_viernes: {
          restaurantes:       porPagarRestaurantes,
          repartidores:       porPagarRepartidores,
          pedidos_pendientes: pedidosTarjetaPendientes,
        },
        por_tier: porTier.map(t => ({
          tier:     t.tier || 'sin_tier',
          neto:     parseFloat(t.dataValues.neto || 0),
          entregas: parseInt(t.dataValues.entregas || 0),
        })),
        por_tipo_envio: pedidosMeta.map(p => ({
          tipo:     p.tipo_envio || 'standard',
          total:    parseInt(p.dataValues.total || 0),
          gmv:      parseFloat(p.dataValues.gmv || 0),
        })),
        por_dia: porDia.map(d => ({
          fecha:    d.dataValues.fecha,
          neto:     parseFloat(d.dataValues.neto || 0),
          entregas: parseInt(d.dataValues.entregas || 0),
        })),
      },
    });
  } catch (e) {
    console.error('Error revenue report:', e);
    res.status(500).json({ ok: false, mensaje: 'Error al generar reporte.' });
  }
}
