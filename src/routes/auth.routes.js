const express = require('express');
const { body } = require('express-validator');
const { registro, verificarOTP, login, solicitarOTP, obtenerPerfil } = require('../controllers/authController');
const { proteger } = require('../middleware/auth');

const router = express.Router();

// Validaciones de registro
const validarRegistro = [
  body('nombre').trim().notEmpty().withMessage('El nombre es obligatorio'),
  body('apellido').trim().notEmpty().withMessage('El apellido es obligatorio'),
  body('telefono')
    .trim().notEmpty().withMessage('El teléfono es obligatorio')
    .matches(/^[0-9]{10}$/).withMessage('El teléfono debe tener 10 dígitos'),
  body('email').optional().isEmail().withMessage('El correo no es válido'),
  body('password')
    .optional()
    .isLength({ min: 6 }).withMessage('La contraseña debe tener mínimo 6 caracteres'),
];

router.post('/registro', validarRegistro, registro);
router.post('/verificar-otp', verificarOTP);
router.post('/solicitar-otp', solicitarOTP);
router.post('/login', [
  body('telefono').notEmpty().withMessage('El teléfono es obligatorio'),
  body('password').notEmpty().withMessage('La contraseña es obligatoria'),
], login);
router.get('/perfil', proteger, obtenerPerfil);

module.exports = router;
