const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const {
  registro, verificarOTP, login, loginSegundoFactor, solicitarOTP, obtenerPerfil, logout,
  recuperarPassword, restablecerPassword,
} = require('../controllers/authController');
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

// 3 SMS de verificación por hora por IP
const limiteOTP = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { ok: false, mensaje: 'Demasiadas solicitudes de código. Espera una hora.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Registro: contador PROPIO (antes compartía el de OTP, así que 3 altas por
// hora por IP se agotaban con reintentos o con varias personas en el mismo
// WiFi — típico en un café o un hotel de Puerto).
const limiteRegistro = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: { ok: false, mensaje: 'Demasiados registros desde esta conexión. Espera una hora o usa otra red.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Recuperación de contraseña: también con contador propio — que alguien pida
// un código no debe consumir los intentos de registro de otra persona.
const limiteReset = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { ok: false, mensaje: 'Pediste demasiados códigos. Espera una hora e intenta de nuevo.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Validaciones de registro
const validarRegistro = [
  body('nombre').trim().notEmpty().withMessage('El nombre es obligatorio'),
  body('apellido').trim().notEmpty().withMessage('El apellido es obligatorio'),
  // Teléfono internacional: la longitud exacta la valida el controlador
  // según el país (utils/telefono.js). Aquí solo se exige que venga y que
  // sean dígitos — un número francés de 9 o uno estadounidense de 10 no
  // pueden compartir una sola regla de "10 dígitos".
  body('telefono')
    .trim().notEmpty().withMessage('El teléfono es obligatorio')
    .matches(/^[+ ()\-0-9]{6,20}$/).withMessage('El teléfono solo puede tener números'),
  body('lada').optional({ values: 'falsy' })
    .matches(/^\+?\d{1,4}$/).withMessage('El código de país no es válido'),
  body('pais').optional({ values: 'falsy' })
    .isLength({ min: 2, max: 2 }).withMessage('El país no es válido'),
  body('email').optional({ values: 'falsy' }).isEmail().withMessage('El correo no es válido'),
  // Doble candado contra escalación de privilegios por 'rol' (el controlador
  // también lo valida). 'admin' NUNCA es auto-servicio: solo por DB o
  // scripts/crear-admin.js.
  body('rol').optional({ values: 'falsy' })
    .isIn(['cliente', 'repartidor', 'negocio']).withMessage('El tipo de cuenta no es válido'),
  body('password')
    .optional()
    .isLength({ min: 8 }).withMessage('La contraseña debe tener mínimo 8 caracteres'),
  body('acepto_terminos')
    .isBoolean().withMessage('El campo acepto_terminos debe ser booleano')
    .equals('true').withMessage('Debes aceptar los Términos de Uso y el Aviso de Privacidad'),
];

router.post('/registro', limiteRegistro, validarRegistro, registro);
router.post('/verificar-otp', limiteAuth, verificarOTP);
router.post('/solicitar-otp', limiteOTP, solicitarOTP);
router.post('/login', limiteAuth, [
  body('telefono').notEmpty().withMessage('El teléfono es obligatorio'),
  body('password').notEmpty().withMessage('La contraseña es obligatoria'),
], login);
// Segundo paso del login de administrador (código de un solo uso). Mismo
// límite por IP que el login: 5 intentos fallidos por 15 min.
router.post('/login-2fa', limiteAuth, [
  body('telefono').notEmpty().withMessage('El teléfono es obligatorio'),
  body('password').notEmpty().withMessage('La contraseña es obligatoria'),
  body('codigo').notEmpty().withMessage('El código es obligatorio'),
], loginSegundoFactor);
// Recuperación de contraseña: 5 códigos por hora por IP (cada uno cuesta un
// SMS o un email real), y el canje del código con el límite de auth
// (5 intentos/15 min) para que no se pueda adivinar por fuerza bruta.
router.post('/recuperar-password', limiteReset, [
  body('telefono').optional({ values: 'falsy' }).trim(),
  body('email').optional({ values: 'falsy' }).isEmail().withMessage('El correo no es válido'),
], recuperarPassword);
router.post('/restablecer-password', limiteAuth, [
  body('codigo').notEmpty().withMessage('El código es obligatorio'),
  body('password').isLength({ min: 8 }).withMessage('La contraseña debe tener mínimo 8 caracteres'),
], restablecerPassword);

router.get ('/perfil', proteger, obtenerPerfil);
router.post('/logout', proteger, logout);

module.exports = router;
