const { Negocio, Producto, Usuario } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');

// ─── GET /api/negocios ────────────────────────────────────
// Lista negocios activos, con filtros por categoría y por ciudad
const listarNegocios = async (req, res) => {
  try {
    const { categoria, buscar, ciudad, pagina = 1, limite = 20 } = req.query;
    const offset = (pagina - 1) * limite;

    // Por defecto solo mostramos negocios de Puerto Escondido (ciudad piloto).
    // Cuando la app envie ?ciudad=huatulco u otra, filtrara por esa.
    const where = { activo: true, ciudad: ciudad || 'puerto_escondido' };
    if (categoria) where.categoria = categoria;
    if (buscar) {
      where.nombre = { [Op.iLike]: `%${buscar}%` };
    }

    const { count, rows: negocios } = await Negocio.findAndCountAll({
      where,
      limit: parseInt(limite),
      offset: parseInt(offset),
      order: [['calificacion_promedio', 'DESC']],
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

// ─── POST /api/negocios ───────────────────────────────────
// Solo un usuario con rol 'negocio' puede crear su negocio
const crearNegocio = async (req, res) => {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ ok: false, errores: errores.array() });
  }
  try {
    const { nombre, descripcion, categoria, direccion, colonia, ciudad, telefono, horarios } = req.body;

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
      ciudad: ciudad || 'puerto_escondido',  // ciudad piloto por defecto
      telefono,
      horarios,
      activo: false,   // Admin debe activarlo
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

    const campos = ['nombre', 'descripcion', 'precio', 'categoria', 'disponible', 'destacado', 'opciones'];
    campos.forEach(c => { if (req.body[c] !== undefined) producto[c] = req.body[c]; });
    await producto.save();

    res.json({ ok: true, mensaje: 'Producto actualizado.', data: { producto } });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar el producto.' });
  }
};

module.exports = {
  listarNegocios,
  obtenerNegocio,
  crearNegocio,
  actualizarNegocio,
  agregarProducto,
  actualizarProducto,
};
