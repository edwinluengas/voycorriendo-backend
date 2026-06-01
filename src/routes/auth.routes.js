const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { registro, verificarOTP, login, solicitarOTP, obtenerPerfil } = require('../controllers/authController');
const { proteger } = require('../middleware/auth');

const router = express.Router();

// 5 intentos por 15 min en rutas de autenticación sensibles
const limiteAuth = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { ok: false, mensaje: 'Demasiados intentos. Espera 15 minutos antes de intentar de nuevo.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 3 SMS por hora por IP
const limiteOTP = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { ok: false, mensaje: 'Demasiadas solicitudes de código. Espera una hora.' },
  standardHeaders: true,
  legacyHeaders: false,
});

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

router.post('/registro', limiteOTP, validarRegistro, registro);
router.post('/verificar-otp', limiteAuth, verificarOTP);
router.post('/solicitar-otp', limiteOTP, solicitarOTP);
router.post('/login', limiteAuth, [
  body('telefono').notEmpty().withMessage('El teléfono es obligatorio'),
  body('password').notEmpty().withMessage('La contraseña es obligatoria'),
], login);
router.get('/perfil', proteger, obtenerPerfil);

module.exports = router;
