const { Negocio, Producto, Usuario, Pedido, LedgerConciliacion, Liquidacion } = require('../models');
const { Op, literal } = require('sequelize');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const { subirImagen } = require('../services/storage.service');
const { COMISION_FLAT, LIMITE_PEDIDOS_DEUDA } = require('../config/precios');
const tg = require('../services/telegram.service');
const { validarDireccionNegocio, bloquearNegocioPermanente } = require('../services/seguridadCuentas.service');

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
      // Auto-aprobar negocio del admin si aun no esta aprobado — pero nunca
      // sin ubicación GPS confirmada, o quedaría "aprobado" sin que los
      // repartidores puedan encontrarlo (mismo riesgo que enviarARevision).
      if (esAdmin && yaExiste.verificacion_estado !== 'aprobado' && yaExiste.latitud && yaExiste.longitud) {
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
    // Auto-aprobar negocio del admin — nunca sin ubicación GPS confirmada
    if (req.usuario.rol === 'admin' && negocio.verificacion_estado !== 'aprobado' && negocio.latitud && negocio.longitud) {
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

    // Proteger categoría reservada — solo admin puede asignar 'ahivoy store'
    if (req.body.categoria === 'ahivoy store' && req.usuario.rol !== 'admin') {
      return res.status(403).json({ ok: false, mensaje: 'Categoría reservada. Contacta a soporte.' });
    }

    // ─── Candado: la misma dirección no puede estar en dos cuentas ────
    // Centralizado en seguridadCuentas.service — NO repetir a mano.
    if (req.body.direccion !== undefined || req.body.colonia !== undefined) {
      const direccionResultante = req.body.direccion !== undefined ? req.body.direccion : negocio.direccion;
      const coloniaResultante   = req.body.colonia   !== undefined ? req.body.colonia   : negocio.colonia;
      const resultado = await validarDireccionNegocio(negocio.id, direccionResultante, coloniaResultante);
      if (!resultado.ok) {
        if (req.body.direccion !== undefined) negocio.direccion = req.body.direccion;
        if (req.body.colonia !== undefined) negocio.colonia = req.body.colonia;
        if (resultado.permanente) {
          negocio.estado_cuenta = 'bloqueado';
          negocio.estado_motivo = `Dirección en lista negra permanente (${resultado.motivo}).`;
          await negocio.save();
          return res.status(403).json({
            ok: false,
            mensaje: 'Este negocio y/o dirección están bloqueados permanentemente. Comunícate con atención a clientes.',
          });
        }
        await bloquearNegocioPermanente(negocio, resultado.motivo);
        return res.status(403).json({
          ok: false,
          mensaje: 'Esa dirección ya está registrada en otra cuenta. Tu cuenta quedó bloqueada — contacta a atención a clientes.',
        });
      }
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
    if (!negocio.foto_portada)           faltantes.push('foto de portada');
    if (!negocio.comprobante_domicilio)  faltantes.push('comprobante de domicilio');
    if (!negocio.documento_ine_dueno)    faltantes.push('INE del dueno');
    if (!negocio.clabe_bancaria)         faltantes.push('CLABE');
    if (!negocio.banco)                  faltantes.push('banco');
    if (!negocio.latitud || !negocio.longitud) faltantes.push('ubicación GPS confirmada');
    if (faltantes.length) {
      return res.status(400).json({
        ok: false,
        mensaje: `Faltan datos: ${faltantes.join(', ')}.`,
      });
    }

    // Defensa en profundidad: la dirección ya se valida en actualizarMiPerfil
    // (incluye lista negra Y duplicado activo — antes aquí solo se
    // revisaba la lista negra, no duplicados colados por otro camino).
    const resultadoDireccion = await validarDireccionNegocio(negocio.id, negocio.direccion, negocio.colonia);
    if (!resultadoDireccion.ok) {
      if (resultadoDireccion.permanente) {
        negocio.estado_cuenta = 'bloqueado';
        negocio.estado_motivo = `Dirección en lista negra permanente (${resultadoDireccion.motivo}).`;
        await negocio.save();
        return res.status(403).json({
          ok: false,
          mensaje: 'Este negocio y/o dirección están bloqueados permanentemente. Comunícate con atención a clientes.',
        });
      }
      await bloquearNegocioPermanente(negocio, resultadoDireccion.motivo);
      return res.status(403).json({
        ok: false,
        mensaje: 'Esa dirección ya está registrada en otra cuenta. Tu cuenta quedó bloqueada — contacta a atención a clientes.',
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
    const ext = safeExt(mime);
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

// ─── DELETE /api/negocios/mi-negocio/productos/:prod_id ────
const eliminarMiProducto = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'No tienes negocio.' });
    const producto = await Producto.findOne({ where: { id: req.params.prod_id, negocio_id: negocio.id } });
    if (!producto) return res.status(404).json({ ok: false, mensaje: 'Producto no encontrado.' });
    await producto.destroy();
    res.json({ ok: true, mensaje: 'Producto eliminado.' });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al eliminar producto.' });
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

    // Mismo candado que actualizarMiPerfil — este endpoint legacy se había
    // quedado sin el chequeo, permitiendo evadir el bloqueo de dirección
    // duplicada/vetada con solo registrar una cuenta nueva.
    const resultadoDireccion = await validarDireccionNegocio(null, direccion, colonia);
    if (!resultadoDireccion.ok) {
      return res.status(403).json({
        ok: false,
        mensaje: resultadoDireccion.permanente
          ? 'Este negocio y/o dirección están bloqueados permanentemente. Comunícate con atención a clientes.'
          : 'Esa dirección ya está registrada en otra cuenta. Contacta a atención a clientes.',
      });
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
      attributes: ['id', 'metodo_pago', 'subtotal', 'creado_en'],
      order: [['creado_en', 'DESC']],
    });

    const ids = pedidos.map((p) => p.id);

    const ledgers = ids.length > 0
      ? await LedgerConciliacion.findAll({
          where: { pedido_id: { [Op.in]: ids } },
          order: [['registrado_en', 'DESC']],
        })
      : [];

    // NOTA: ledger.comision_plataforma es el corte de la plataforma sobre el
    // FEE DE ENVÍO ($35 envío − $30 repartidor = $5), no una comisión sobre
    // la comida del negocio. La única comisión que le toca al negocio es el
    // FEE_PLATAFORMA flat ($35/pedido, constante COMISION_FLAT) — en efectivo
    // se acumula como deuda_plataforma (se liquida aparte por SPEI, no se
    // resta aquí); en tarjeta se descuenta del depósito porque la plataforma
    // ya retuvo el dinero completo vía Mercado Pago.
    const totalSubtotal   = ledgers.reduce((s, l) => s + parseFloat(l.subtotal_productos || 0), 0);

    // ── Desglose tarjeta vs efectivo ─────────────────────────
    const ledgersTarjeta  = ledgers.filter((l) => l.metodo_pago !== 'efectivo');
    const ledgersEfectivo = ledgers.filter((l) => l.metodo_pago === 'efectivo');
    const subtotalTarjeta  = ledgersTarjeta.reduce((s, l)  => s + parseFloat(l.subtotal_productos || 0), 0);
    const subtotalEfectivo = ledgersEfectivo.reduce((s, l) => s + parseFloat(l.subtotal_productos || 0), 0);

    const totalComisiones  = ledgers.length * COMISION_FLAT;
    // El fee de MP prorrateado a la porción del negocio también se descuenta
    // de su liquidación (modelo cuenta concentradora 2026-07-23).
    const feeMpTarjeta = ledgersTarjeta.reduce((s, l) => s + parseFloat(l.fee_mp_negocio || 0), 0);
    const totalLiquidacion = subtotalEfectivo + Math.max(0, subtotalTarjeta - ledgersTarjeta.length * COMISION_FLAT - feeMpTarjeta);

    // ── Pendientes de corte del viernes (tarjeta no conciliada) ─
    const ledgersSinConciliar = ledgersTarjeta.filter((l) => !l.conciliado_negocio);
    const ledgersTarjetaConciliada = ledgersTarjeta.filter((l) => l.conciliado_negocio);
    const plataformaDebeNegocio = ledgersSinConciliar.reduce(
      (s, l) => s + parseFloat(l.subtotal_productos || 0) - COMISION_FLAT - parseFloat(l.fee_mp_negocio || 0), 0
    );
    // De lo no conciliado: ya reservado en una liquidación pendiente de
    // confirmar (retiro solicitado, esperando que un admin confirme el
    // depósito real) vs. lo que sigue libre para pedir un retiro nuevo.
    const ledgersEnProceso = ledgersSinConciliar.filter((l) => l.liquidacion_negocio_id);
    const ledgersDisponibles = ledgersSinConciliar.filter((l) => !l.liquidacion_negocio_id);
    const enProcesoPago = ledgersEnProceso.reduce(
      (s, l) => s + parseFloat(l.subtotal_productos || 0) - COMISION_FLAT - parseFloat(l.fee_mp_negocio || 0), 0
    );
    const disponibleParaRetiro = ledgersDisponibles.reduce(
      (s, l) => s + parseFloat(l.subtotal_productos || 0) - COMISION_FLAT - parseFloat(l.fee_mp_negocio || 0), 0
    );

    // ── Pagado vs generado ────────────────────────────────────
    // Efectivo: el negocio ya tiene el subtotal COMPLETO en mano (se lo dio
    // el repartidor) — cuenta como "pagado" desde ya. El fee de $35 NO se
    // resta aquí: es una deuda aparte (deuda_plataforma) que se liquida por
    // SPEI, no algo que reduzca lo que el negocio ya recibió en efectivo.
    // Tarjeta: solo cuenta como pagado una vez conciliado (corte semanal o
    // retiro diario ya procesado), y ahí sí se descuenta el fee flat porque
    // la plataforma retiene el dinero hasta liquidar.
    const liquidacionEfectivo = subtotalEfectivo;
    const liquidacionTarjetaPagada = ledgersTarjetaConciliada.reduce(
      (s, l) => s + parseFloat(l.subtotal_productos || 0) - COMISION_FLAT - parseFloat(l.fee_mp_negocio || 0), 0
    );
    const ingresoPagado = liquidacionEfectivo + liquidacionTarjetaPagada;

    // ── Deuda acumulada del negocio con la plataforma ─────────
    const deudaActual = parseFloat(negocio.deuda_plataforma || 0);

    // ── Proyección del próximo viernes (neto) ─────────────────
    // Depósito viernes = (pedidos tarjeta no conciliados × (subtotal − $35)) − deuda efectivo
    const netoViernesProyectado = Math.max(0, plataformaDebeNegocio - deudaActual);

    // ── Pedidos del día y la semana ───────────────────────────
    const ahora   = new Date();
    const inicioDia    = new Date(ahora.toDateString());
    const inicioSemana = new Date(ahora);
    inicioSemana.setDate(ahora.getDate() - ahora.getDay());
    inicioSemana.setHours(0, 0, 0, 0);

    const ledgersHoy    = ledgers.filter((l) => new Date(l.registrado_en) >= inicioDia);
    const ledgersSemana = ledgers.filter((l) => new Date(l.registrado_en) >= inicioSemana);

    res.json({
      ok: true,
      data: {
        pedidos_completados: pedidos.length,
        total_pedidos:       pedidos.length,
        subtotal_productos:  totalSubtotal,
        comisiones_pagadas:  totalComisiones,
        liquidacion_comida:  totalLiquidacion,
        ingreso_generado:    totalLiquidacion,
        ingreso_pagado:      ingresoPagado,
        ingreso_por_pagar:   Math.max(0, totalLiquidacion - ingresoPagado),
        // Desglose
        subtotal_tarjeta:    subtotalTarjeta,
        subtotal_efectivo:   subtotalEfectivo,
        // Plataforma debe al negocio (tarjeta pendiente de corte, total)
        plataforma_debe:     Math.max(0, plataformaDebeNegocio),
        // De lo anterior: reservado en un retiro ya solicitado, pendiente de
        // que un admin confirme el depósito real, vs. libre para pedir otro.
        en_proceso_pago:     Math.max(0, enProcesoPago),
        disponible_retiro:   Math.max(0, disponibleParaRetiro),
        // Negocio debe a la plataforma (fees efectivo acumulados)
        deuda_plataforma:    deudaActual,
        bloqueado_por_deuda: negocio.bloqueado_por_deuda,
        pedidos_efectivo_pendientes: negocio.pedidos_efectivo_pendientes || 0,
        limite_pedidos_deuda: LIMITE_PEDIDOS_DEUDA,
        // Proyección del próximo viernes
        neto_viernes:        netoViernesProyectado,
        // Períodos
        ventas_hoy:    ledgersHoy.reduce((s, l)    => s + parseFloat(l.subtotal_productos || 0), 0),
        ventas_semana: ledgersSemana.reduce((s, l) => s + parseFloat(l.subtotal_productos || 0), 0),
        // CLABE parcialmente enmascarada — admin comunica CLABE completa por canal seguro
        clabe_plataforma:   process.env.CLABE_PLATAFORMA
          ? `****${process.env.CLABE_PLATAFORMA.slice(-4)}`
          : '****7465',
        banco_plataforma:   process.env.BANCO_PLATAFORMA || 'Citibanamex',
        referencia_spei:    `VC-${negocio.id.slice(0, 8).toUpperCase()}`,
        resumen:             ledgers.slice(0, 30),
      },
    });
  } catch (error) {
    console.error('Error en gananciasNegocio:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener ganancias.' });
  }
};

// ─── POST /api/negocios/mi-negocio/pagar-deuda ─────────────
// El restaurante notifica que hizo la transferencia SPEI.
// Admin valida y usa PATCH /api/admin/negocios/:id/confirmar-pago para liberar.
const registrarPagoDeuda = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'No tienes negocio registrado.' });

    const { referencia_spei, monto } = req.body;
    if (!referencia_spei) {
      return res.status(400).json({ ok: false, mensaje: 'Proporciona la referencia de tu transferencia SPEI.' });
    }

    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminChatId) {
      tg.enviar(adminChatId,
        `💰 <b>Pago de deuda recibido</b>\n` +
        `Negocio: ${negocio.nombre}\n` +
        `ID: <code>${negocio.id}</code>\n` +
        `Monto declarado: $${parseFloat(monto || 0).toFixed(2)} MXN\n` +
        `Referencia SPEI: <b>${referencia_spei}</b>\n\n` +
        `Verifica en la cuenta bancaria y confirma en el panel admin.`
      ).catch(() => {});
    }

    res.json({
      ok: true,
      mensaje: 'Hemos recibido tu notificación de pago. Un operador la verificará y desbloqueará tu cuenta en breve.',
      data: { deuda_actual: parseFloat(negocio.deuda_plataforma || 0) },
    });
  } catch (error) {
    console.error('Error en registrarPagoDeuda:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al registrar el pago.' });
  }
};

// ─── POST /api/negocios/mi-negocio/retiro-diario ───────────
// Adelanto inmediato de las ganancias de tarjeta/MP aún no conciliadas,
// con fee (el corte semanal del viernes es gratis).
const retiroDiarioNegocio = async (req, res) => {
  try {
    const { PCT_DESCUENTO_PAGO_DIARIO } = require('../config/precios');

    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'No tienes negocio registrado.' });

    const pedidos = await Pedido.findAll({
      where: { negocio_id: negocio.id, estado: 'entregado', metodo_pago: { [Op.ne]: 'efectivo' } },
      attributes: ['id'],
    });
    const ids = pedidos.map((p) => p.id);
    // Solo filas SIN reservar por otra liquidación aún pendiente — si ya
    // están dentro de un retiro solicitado (aunque no confirmado todavía),
    // no cuentan como "disponible" para pedir otro retiro encima.
    const ledgers = ids.length > 0
      ? await LedgerConciliacion.findAll({ where: { pedido_id: { [Op.in]: ids }, conciliado_negocio: false, liquidacion_negocio_id: null } })
      : [];

    const disponible = Math.max(0, ledgers.reduce(
      (s, l) => s + parseFloat(l.subtotal_productos || 0) - COMISION_FLAT - parseFloat(l.fee_mp_negocio || 0), 0
    ));
    // Pago diario anticipado: 5% de descuento sobre el saldo pendiente
    // (modelo 2026-07-23 — reemplaza el fee fijo de $10). Viernes gratis.
    const feeDiario = Math.round(disponible * PCT_DESCUENTO_PAGO_DIARIO * 100) / 100;
    const neto = Math.round((disponible - feeDiario) * 100) / 100;

    if (neto <= 0) {
      return res.status(400).json({
        ok: false,
        mensaje: `No tienes saldo disponible para el pago diario. Tienes $${disponible.toFixed(2)} MXN.`,
      });
    }

    if (negocio.bloqueado_por_deuda) {
      return res.status(403).json({ ok: false, mensaje: 'Tu negocio está bloqueado por deuda. Liquida tu saldo primero.' });
    }

    // Reserva atómica: "claim" de las filas del ledger dentro de esta
    // liquidación (aún NO se marcan conciliado_negocio). Compara el conteo
    // exacto contra lo intentado: si una request paralela ganó la carrera y
    // alcanzó a reservar solo ALGUNAS de estas filas, se revierte esa
    // reserva parcial huérfana en vez de dejarla inconsistente. No toca
    // conciliado_repartidor ni liquidacion_repartidor_id: es un pago
    // independiente que el repartidor cobra por su propio camino.
    const liquidacionId = crypto.randomUUID();
    const idsIntentados = ledgers.map((l) => l.id);
    const [reservados] = await LedgerConciliacion.update(
      { liquidacion_negocio_id: liquidacionId },
      { where: { id: { [Op.in]: idsIntentados }, conciliado_negocio: false, liquidacion_negocio_id: null } }
    );
    if (reservados !== idsIntentados.length) {
      if (reservados > 0) {
        await LedgerConciliacion.update({ liquidacion_negocio_id: null }, { where: { liquidacion_negocio_id: liquidacionId } });
      }
      return res.status(409).json({ ok: false, mensaje: 'Ya se solicitó un retiro para parte de este saldo. Intenta de nuevo en unos segundos.' });
    }

    // El pago real se hace manualmente por SPEI — la liquidación queda
    // 'pendiente' hasta que un admin confirme el depósito real (monto y
    // referencia) vía POST /api/admin/liquidaciones/:id/confirmar. Solo ahí
    // se marca conciliado_negocio = true.
    await Liquidacion.create({
      id: liquidacionId,
      entidad_tipo: 'negocio',
      entidad_id: negocio.id,
      tipo: 'retiro_diario',
      estado: 'pendiente',
      monto_calculado: neto,
      pedidos_liquidados: ledgers.length,
      ledger_ids: ledgers.map((l) => l.id),
    });

    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminChatId) {
      tg.enviar(adminChatId,
        `⚡ <b>Retiro diario solicitado (negocio)</b>\n` +
        `Negocio: ${negocio.nombre}\n` +
        `ID negocio: <code>${negocio.id}</code>\n` +
        `ID liquidación: <code>${liquidacionId}</code>\n` +
        `Disponible: $${disponible.toFixed(2)} | Descuento 5%: $${feeDiario.toFixed(2)} | Neto: $${neto.toFixed(2)} MXN\n` +
        `Confirma con POST /api/admin/liquidaciones/${liquidacionId}/confirmar`
      ).catch(() => {});
    }

    res.json({
      ok: true,
      mensaje: `Retiro solicitado ($${neto.toFixed(2)} MXN, con 5% de descuento por pago diario). Pendiente de confirmación — lo recibirás por SPEI.`,
      data: { liquidacion_id: liquidacionId, disponible, fee: feeDiario, neto },
    });
  } catch (error) {
    console.error('Error en retiroDiarioNegocio:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al procesar el retiro.' });
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
  eliminarMiProducto,
  subirFotoProducto,
  gananciasNegocio,
  registrarPagoDeuda,
  retiroDiarioNegocio,
  // Legacy / operacion
  crearNegocio,
  actualizarNegocio,
  agregarProducto,
  actualizarProducto,
};
