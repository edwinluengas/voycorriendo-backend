const { Negocio, Producto, Usuario, Pedido, LedgerConciliacion, RestaurantToken } = require('../models');
const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const { subirImagen } = require('../services/storage.service');

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const safeExt = (mime) => MIME_EXT[(mime || '').toLowerCase()] || 'jpg';

// ═══════════════════════════════════════════════════════════
// PUBLIC: feed para clientes
// ═══════════════════════════════════════════════════════════

// ─── GET /api/negocios ────────────────────────────────────
const listarNegocios = async (req, res) => {
  try {
    const { categoria, buscar, ciudad, pagina = 1, limite = 50 } = req.query;
    const offset = (pagina - 1) * limite;

    // Solo aprobados, activos, y NO suspendidos/bloqueados
    const where = {
      activo: true,
      verificacion_estado: 'aprobado',
      estado_cuenta: { [Op.notIn]: ['suspendido', 'bloqueado'] },
      ciudad: ciudad || 'puerto_escondido',
    };
    if (categoria) where.categoria = categoria;
    if (buscar) {
      where.nombre = { [Op.iLike]: `%${buscar}%` };
    }

    const { count, rows: negocios } = await Negocio.findAndCountAll({
      where,
      limit: parseInt(limite),
      offset: parseInt(offset),
      order: [
        ['destacado_calidad', 'DESC'],
        ['calificacion_promedio', 'DESC'],
      ],
      attributes: { exclude: ['clabe_bancaria', 'usuario_id'] },
    });

    res.json({
      ok: true,
      data: {
        negocios,
        total: count,
        pagina: parseInt(pagina),
        paginas: Math.ceil(count / limite),
      },
    });
  } catch (error) {
    console.error('Error al listar negocios:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener los negocios.' });
  }
};

// ─── GET /api/negocios/:id ────────────────────────────────
const obtenerNegocio = async (req, res) => {
  try {
    const negocio = await Negocio.findByPk(req.params.id, {
      attributes: { exclude: ['clabe_bancaria'] },
      include: [{
        model: Producto,
        as: 'productos',
        where: { disponible: true },
        required: false,
        order: [['categoria', 'ASC'], ['nombre', 'ASC']],
      }],
    });

    if (!negocio) {
      return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    }
    res.json({ ok: true, data: { negocio } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener el negocio.' });
  }
};

// ═══════════════════════════════════════════════════════════
// ONBOARDING: wizard del dueno del negocio
// ═══════════════════════════════════════════════════════════

// ─── POST /api/negocios/activar ────────────────────────────
// Click en "Activar modo negocio" en perfil. Crea fila vacia.
const activarModoNegocio = async (req, res) => {
  try {
    const esAdmin = req.usuario.rol === 'admin';
    const yaExiste = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (yaExiste) {
      // Auto-aprobar negocio del admin si aun no esta aprobado
      if (esAdmin && yaExiste.verificacion_estado !== 'aprobado') {
        yaExiste.verificacion_estado = 'aprobado';
        yaExiste.activo = true;
        await yaExiste.save();
      }
      return res.json({
        ok: true,
        mensaje: 'Ya tienes un negocio registrado.',
        data: { negocio: yaExiste },
      });
    }
    const negocio = await Negocio.create({
      usuario_id: req.usuario.id,
      verificacion_estado: esAdmin ? 'aprobado' : 'pendiente',
      activo: esAdmin,
      ciudad: 'puerto_escondido',
    });
    res.status(201).json({
      ok: true,
      mensaje: 'Modo negocio activado. Completa tus datos para empezar.',
      data: { negocio },
    });
  } catch (error) {
    console.error('Error en activarModoNegocio:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al activar modo negocio.' });
  }
};

// ─── GET /api/negocios/mi-negocio ──────────────────────────
// El dueno consulta su propio negocio (con todos los campos).
const obtenerMiNegocio = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({
      where: { usuario_id: req.usuario.id },
      include: [{ model: Producto, as: 'productos', required: false, order: [['nombre', 'ASC']] }],
    });
    if (!negocio) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Aun no tienes negocio. Activalo desde tu perfil.',
      });
    }
    // Auto-aprobar negocio del admin
    if (req.usuario.rol === 'admin' && negocio.verificacion_estado !== 'aprobado') {
      negocio.verificacion_estado = 'aprobado';
      negocio.activo = true;
      await negocio.save();
    }
    res.json({ ok: true, data: { negocio } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener tu negocio.' });
  }
};

// ─── PATCH /api/negocios/mi-negocio ────────────────────────
// Actualiza datos del wizard. Acepta cualquier subset.
const actualizarMiPerfil = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Activa primero el modo negocio desde tu perfil.',
      });
    }
    if (['suspendido', 'bloqueado'].includes(negocio.estado_cuenta)) {
      return res.status(403).json({
        ok: false,
        mensaje: 'Tu cuenta esta restringida. Contacta a soporte.',
      });
    }

    const camposEditables = [
      'nombre', 'descripcion', 'categoria',
      'direccion', 'colonia', 'latitud', 'longitud',
      'telefono', 'horarios',
      'tiempo_entrega_min', 'tiempo_entrega_max',
      'clabe_bancaria', 'banco',
      // URLs de fotos (las setea /documento, pero permitimos override)
      'logo', 'foto_portada', 'foto_local',
      'comprobante_domicilio', 'documento_rfc', 'documento_ine_dueno',
    ];
    camposEditables.forEach(c => {
      if (req.body[c] !== undefined) negocio[c] = req.body[c];
    });

    // Proteger categoría reservada — solo admin puede asignar 'ahivoy store'
    if (negocio.categoria === 'ahivoy store' && req.usuario.rol !== 'admin') {
      return res.status(403).json({ ok: false, mensaje: 'Categoría reservada. Contacta a soporte.' });
    }

    await negocio.save();

    res.json({ ok: true, mensaje: 'Datos guardados.', data: { negocio } });
  } catch (error) {
    console.error('Error en actualizarMiPerfil:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar tus datos.' });
  }
};

// ─── POST /api/negocios/documento ──────────────────────────
// Sube documento/foto a Supabase Storage.
// Body: { tipo, base64, mime }
//   tipo: 'logo' | 'foto_portada' | 'foto_local' |
//         'comprobante_domicilio' | 'documento_rfc' | 'documento_ine_dueno'
const subirDocumento = async (req, res) => {
  try {
    const { tipo, base64, mime } = req.body;
    const tiposValidos = {
      logo: 'logo',
      foto_portada: 'foto_portada',
      foto_local: 'foto_local',
      comprobante_domicilio: 'comprobante_domicilio',
      documento_rfc: 'documento_rfc',
      documento_ine_dueno: 'documento_ine_dueno',
    };
    const columna = tiposValidos[tipo];
    if (!columna) {
      return res.status(400).json({ ok: false, mensaje: 'Tipo de documento invalido.' });
    }
    if (!base64 || !mime) {
      return res.status(400).json({ ok: false, mensaje: 'Falta base64 o mime.' });
    }

    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) {
      return res.status(404).json({ ok: false, mensaje: 'Activa primero el modo negocio.' });
    }

    const ext = safeExt(mime);
    const ruta = `negocios/${negocio.id}/${tipo}_${Date.now()}.${ext}`;
    const url = await subirImagen('documentos-negocios', ruta, base64, mime);

    negocio[columna] = url;
    await negocio.save();

    res.json({ ok: true, mensaje: 'Documento subido.', data: { url, tipo } });
  } catch (error) {
    console.error('Error en subirDocumento:', error);
    res.status(500).json({
      ok: false,
      mensaje: error.message || 'No se pudo subir el documento.',
    });
  }
};

// ─── POST /api/negocios/enviar-a-revision ──────────────────
const enviarARevision = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) {
      return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    }
    const faltantes = [];
    if (!negocio.nombre)                 faltantes.push('nombre');
    if (!negocio.categoria)              faltantes.push('categoria');
    if (!negocio.direccion)              faltantes.push('direccion');
    if (!negocio.telefono)               faltantes.push('telefono');
    if (!negocio.foto_local)             faltantes.push('foto del local');
    if (!negocio.comprobante_domicilio)  faltantes.push('comprobante de domicilio');
    if (!negocio.documento_ine_dueno)    faltantes.push('INE del dueno');
    if (!negocio.clabe_bancaria)         faltantes.push('CLABE');
    if (faltantes.length) {
      return res.status(400).json({
        ok: false,
        mensaje: `Faltan datos: ${faltantes.join(', ')}.`,
      });
    }

    negocio.verificacion_estado = 'en_revision';
    negocio.enviado_revision_en = new Date();
    await negocio.save();

    res.json({
      ok: true,
      mensaje: '¡Listo! Estamos revisando tu negocio. Te avisaremos en menos de 48 horas.',
      data: { negocio },
    });
  } catch (error) {
    console.error('Error en enviarARevision:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al enviar a revision.' });
  }
};

// ─── GET /api/negocios/mi-negocio/productos ────────────────
const listarMisProductos = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'No tienes negocio.' });
    const productos = await Producto.findAll({
      where: { negocio_id: negocio.id },
      order: [['categoria', 'ASC'], ['nombre', 'ASC']],
    });
    res.json({ ok: true, data: { productos } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al obtener productos.' });
  }
};

// ─── POST /api/negocios/mi-negocio/productos ───────────────
const crearMiProducto = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'No tienes negocio.' });
    const { nombre, descripcion, precio, categoria, tiempo_preparacion } = req.body;
    if (!nombre || precio == null) {
      return res.status(400).json({ ok: false, mensaje: 'Nombre y precio son obligatorios.' });
    }
    const producto = await Producto.create({
      negocio_id: negocio.id,
      nombre, descripcion, precio: parseFloat(precio),
      categoria: categoria || 'general',
      tiempo_preparacion: tiempo_preparacion || 15,
      disponible: true,
    });
    res.status(201).json({ ok: true, data: { producto } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al crear producto.' });
  }
};

// ─── PATCH /api/negocios/mi-negocio/productos/:prod_id ─────
const actualizarMiProducto = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'No tienes negocio.' });
    const producto = await Producto.findOne({ where: { id: req.params.prod_id, negocio_id: negocio.id } });
    if (!producto) return res.status(404).json({ ok: false, mensaje: 'Producto no encontrado.' });
    const campos = ['nombre', 'descripcion', 'precio', 'categoria', 'disponible', 'destacado', 'tiempo_preparacion', 'requiere_id'];
    campos.forEach(c => { if (req.body[c] !== undefined) producto[c] = req.body[c]; });
    await producto.save();
    res.json({ ok: true, data: { producto } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar producto.' });
  }
};

// ─── POST /api/negocios/mi-negocio/productos/:prod_id/foto ─
const subirFotoProducto = async (req, res) => {
  try {
    const { base64, mime } = req.body;
    if (!base64 || !mime) return res.status(400).json({ ok: false, mensaje: 'Falta base64 o mime.' });
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'No tienes negocio.' });
    const producto = await Producto.findOne({ where: { id: req.params.prod_id, negocio_id: negocio.id } });
    if (!producto) return res.status(404).json({ ok: false, mensaje: 'Producto no encontrado.' });
    const ext = mime.split('/')[1] || 'jpg';
    const ruta = `negocios/${negocio.id}/productos/${producto.id}_${Date.now()}.${ext}`;
    const url = await subirImagen('documentos-negocios', ruta, base64, mime);
    producto.imagen = url;
    await producto.save();
    res.json({ ok: true, data: { url } });
  } catch (error) {
    console.error('Error en subirFotoProducto:', error);
    res.status(500).json({ ok: false, mensaje: error.message || 'No se pudo subir la foto.' });
  }
};

// ─── PATCH /api/negocios/apertura ──────────────────────────
// "Abrir / cerrar" el negocio (estilo Go Online del repartidor).
const cambiarApertura = async (req, res) => {
  try {
    const { abierto } = req.body;
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) {
      return res.status(404).json({ ok: false, mensaje: 'No tienes negocio.' });
    }
    if (abierto && negocio.verificacion_estado !== 'aprobado') {
      return res.status(403).json({
        ok: false,
        mensaje: 'Tu negocio aun no ha sido aprobado por el equipo.',
      });
    }
    if (abierto && ['suspendido', 'bloqueado'].includes(negocio.estado_cuenta)) {
      return res.status(403).json({
        ok: false,
        mensaje: `Tu negocio esta ${negocio.estado_cuenta}. Contacta a soporte.`,
      });
    }

    negocio.abierto_ahora = !!abierto;
    await negocio.save();

    res.json({
      ok: true,
      mensaje: abierto ? 'Negocio abierto. Recibiendo pedidos.' : 'Negocio cerrado.',
      data: { abierto: negocio.abierto_ahora },
    });
  } catch (error) {
    console.error('Error en cambiarApertura:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al cambiar estado.' });
  }
};

// ═══════════════════════════════════════════════════════════
// LEGACY: crearNegocio en una sola llamada (no se usa en wizard)
// ═══════════════════════════════════════════════════════════
const crearNegocio = async (req, res) => {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ ok: false, errores: errores.array() });
  }
  try {
    const { nombre, descripcion, categoria, direccion, colonia, ciudad, telefono, horarios, latitud, longitud } = req.body;

    const yaExiste = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (yaExiste) {
      return res.status(409).json({ ok: false, mensaje: 'Ya tienes un negocio registrado.' });
    }

    const negocio = await Negocio.create({
      usuario_id: req.usuario.id,
      nombre,
      descripcion,
      categoria,
      direccion,
      colonia,
      ciudad: ciudad || 'puerto_escondido',
      telefono,
      horarios,
      latitud:  latitud  != null ? latitud  : null,
      longitud: longitud != null ? longitud : null,
      activo: false,
      verificacion_estado: 'en_revision',
    });

    res.status(201).json({
      ok: true,
      mensaje: 'Negocio registrado. El equipo de VoyCorriendo lo revisará pronto.',
      data: { negocio },
    });
  } catch (error) {
    console.error('Error al crear negocio:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al registrar el negocio.' });
  }
};

// ─── PUT /api/negocios/:id ────────────────────────────────
const actualizarNegocio = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({
      where: { id: req.params.id, usuario_id: req.usuario.id },
    });
    if (!negocio) {
      return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    }

    const camposPermitidos = ['nombre', 'descripcion', 'direccion', 'colonia',
      'telefono', 'horarios', 'tiempo_entrega_min', 'tiempo_entrega_max', 'abierto_ahora'];

    camposPermitidos.forEach(campo => {
      if (req.body[campo] !== undefined) negocio[campo] = req.body[campo];
    });

    await negocio.save();
    res.json({ ok: true, mensaje: 'Negocio actualizado.', data: { negocio } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar el negocio.' });
  }
};

// ─── POST /api/negocios/:id/productos ─────────────────────
const agregarProducto = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({
      where: { id: req.params.id, usuario_id: req.usuario.id },
    });
    if (!negocio) {
      return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    }

    const { nombre, descripcion, precio, categoria, tiempo_preparacion, opciones } = req.body;
    const producto = await Producto.create({
      negocio_id: negocio.id,
      nombre,
      descripcion,
      precio,
      categoria,
      tiempo_preparacion,
      opciones,
    });

    res.status(201).json({ ok: true, mensaje: 'Producto agregado.', data: { producto } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al agregar el producto.' });
  }
};

// ─── PUT /api/negocios/:id/productos/:prod_id ─────────────
const actualizarProducto = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { id: req.params.id, usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Sin acceso.' });

    const producto = await Producto.findOne({ where: { id: req.params.prod_id, negocio_id: negocio.id } });
    if (!producto) return res.status(404).json({ ok: false, mensaje: 'Producto no encontrado.' });

    const campos = ['nombre', 'descripcion', 'precio', 'categoria', 'disponible', 'destacado', 'opciones', 'imagen', 'requiere_id'];
    campos.forEach(c => { if (req.body[c] !== undefined) producto[c] = req.body[c]; });
    await producto.save();

    res.json({ ok: true, mensaje: 'Producto actualizado.', data: { producto } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar el producto.' });
  }
};

// ─── GET /api/negocios/mi-negocio/ganancias ───────────────
const gananciasNegocio = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'No tienes negocio registrado.' });

    const pedidos = await Pedido.findAll({
      where: { negocio_id: negocio.id, estado: 'entregado' },
      attributes: ['id'],
      order: [['creado_en', 'DESC']],
    });

    const ids = pedidos.map((p) => p.id);

    const ledgers = ids.length > 0
      ? await LedgerConciliacion.findAll({
          where: { pedido_id: { [Op.in]: ids } },
          order: [['registrado_en', 'DESC']],
        })
      : [];

    const totalSubtotal    = ledgers.reduce((s, l) => s + parseFloat(l.subtotal_productos    || 0), 0);
    const totalComisiones  = ledgers.reduce((s, l) => s + parseFloat(l.comision_plataforma   || 0), 0);
    const totalLiquidacion = ledgers.reduce((s, l) => s + parseFloat(l.liquidacion_comida    || 0), 0);

    const tokenesActivos = await RestaurantToken.findAll({
      where: { restaurant_id: negocio.id, tokens_remaining: { [Op.gt]: 0 } },
      attributes: ['tokens_remaining'],
    });
    const tokensDisponibles = tokenesActivos.reduce((s, t) => s + (t.tokens_remaining || 0), 0);

    res.json({
      ok: true,
      data: {
        pedidos_completados: pedidos.length,
        subtotal_productos:  totalSubtotal,
        comisiones_pagadas:  totalComisiones,
        liquidacion_comida:  totalLiquidacion,
        tokens_disponibles:  tokensDisponibles,
        resumen:             ledgers.slice(0, 30),
      },
    });
  } catch (error) {
    console.error('Error en gananciasNegocio:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener ganancias.' });
  }
};

module.exports = {
  // Public
  listarNegocios,
  obtenerNegocio,
  // Onboarding wizard
  activarModoNegocio,
  obtenerMiNegocio,
  actualizarMiPerfil,
  subirDocumento,
  enviarARevision,
  cambiarApertura,
  // Gestion de productos del dueno
  listarMisProductos,
  crearMiProducto,
  actualizarMiProducto,
  subirFotoProducto,
  gananciasNegocio,
  // Legacy / operacion
  crearNegocio,
  actualizarNegocio,
  agregarProducto,
  actualizarProducto,
};
