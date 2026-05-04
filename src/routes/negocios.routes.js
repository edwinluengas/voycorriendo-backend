const express = require('express');
const { body } = require('express-validator');
const {
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
  // Legacy
  crearNegocio,
  actualizarNegocio,
  agregarProducto,
  actualizarProducto,
} = require('../controllers/negociosController');
const { proteger, restringirA } = require('../middleware/auth');

const router = express.Router();

// ─── Publicas (sin token) ────────────────────────────────
router.get('/', listarNegocios);

// ─── Wizard de onboarding (cualquier usuario logueado) ────
// IMPORTANTE: estas rutas deben ir ANTES de '/:id' porque
// si no, Express interpreta 'mi-negocio' como un :id.
router.post ('/activar',           proteger, activarModoNegocio);
router.get  ('/mi-negocio',        proteger, obtenerMiNegocio);
router.patch('/mi-negocio',        proteger, actualizarMiPerfil);
router.post ('/documento',         proteger, subirDocumento);
router.post ('/enviar-a-revision', proteger, enviarARevision);
router.patch('/apertura', proteger, [
  body('abierto').isBoolean(),
], cambiarApertura);

// ─── Detalle publico (debe ir DESPUES de las rutas con nombre) ─
router.get('/:id', obtenerNegocio);

// ─── Legacy / operacion ──────────────────────────────────
router.post('/', proteger, [
  body('nombre').notEmpty().withMessage('El nombre del negocio es obligatorio'),
  body('categoria').isIn([
    'restaurante','tienda_conveniencia','farmacia','papeleria',
    'panaderia','ahivoy store','abarrotes','distribuidora','otro',
  ]).withMessage('Categoria no valida'),
  body('direccion').notEmpty().withMessage('La dirección es obligatoria'),
], crearNegocio);

router.put('/:id', proteger, restringirA('negocio', 'admin'), actualizarNegocio);
router.post('/:id/productos', proteger, restringirA('negocio', 'admin'), [
  body('nombre').notEmpty().withMessage('El nombre del producto es obligatorio'),
  body('precio').isFloat({ min: 0 }).withMessage('El precio debe ser un número positivo'),
], agregarProducto);
router.put('/:id/productos/:prod_id', proteger, restringirA('negocio', 'admin'), actualizarProducto);

module.exports = router;
