const express = require('express');
const { body } = require('express-validator');
const {
  listarNegocios, obtenerNegocio, crearNegocio,
  actualizarNegocio, agregarProducto, actualizarProducto,
} = require('../controllers/negociosController');
const { proteger, restringirA } = require('../middleware/auth');

const router = express.Router();

// Públicas (sin token)
router.get('/',    listarNegocios);
router.get('/:id', obtenerNegocio);

// Requieren autenticación
router.post('/', proteger, restringirA('negocio', 'admin'), [
  body('nombre').notEmpty().withMessage('El nombre del negocio es obligatorio'),
  body('categoria').isIn(['restaurante','farmacia','abarrotes','distribuidora','otro'])
    .withMessage('Categoría no válida'),
  body('direccion').notEmpty().withMessage('La dirección es obligatoria'),
], crearNegocio);

router.put('/:id',        proteger, restringirA('negocio', 'admin'), actualizarNegocio);
router.post('/:id/productos', proteger, restringirA('negocio', 'admin'), [
  body('nombre').notEmpty().withMessage('El nombre del producto es obligatorio'),
  body('precio').isFloat({ min: 0 }).withMessage('El precio debe ser un número positivo'),
], agregarProducto);
router.put('/:id/productos/:prod_id', proteger, restringirA('negocio', 'admin'), actualizarProducto);

module.exports = router;
