/**
 * Rutas del Panel de Administracion.
 *
 * TODAS protegidas por: proteger + restringirA('admin').
 * Solo usuarios con rol = 'admin' pueden tocarlas.
 */
const express = require('express');
const { proteger, restringirA } = require('../middleware/auth');
const ctrl = require('../controllers/adminController');

const router = express.Router();

// Aplica auth + admin a TODAS las rutas de este router
router.use(proteger);
router.use(restringirA('admin'));

// ─── Dashboard general ──────────────────────────────────────
router.get('/dashboard', ctrl.dashboard);

// ─── Repartidores ───────────────────────────────────────────
router.get   ('/repartidores',                 ctrl.listarRepartidores);
router.get   ('/repartidores/:id',             ctrl.obtenerRepartidor);
router.patch ('/repartidores/:id/aprobar',     ctrl.aprobarRepartidor);
router.patch ('/repartidores/:id/rechazar',    ctrl.rechazarRepartidor);
router.patch ('/repartidores/:id/cuenta',      ctrl.cambiarEstadoCuentaRepartidor);

// ─── Negocios ───────────────────────────────────────────────
router.get   ('/negocios',                     ctrl.listarNegocios);
router.get   ('/negocios/:id',                 ctrl.obtenerNegocio);
router.patch ('/negocios/:id/aprobar',         ctrl.aprobarNegocio);
router.patch ('/negocios/:id/rechazar',        ctrl.rechazarNegocio);
router.patch ('/negocios/:id/cuenta',          ctrl.cambiarEstadoCuentaNegocio);

// ─── Usuarios (busqueda) ────────────────────────────────────
router.get   ('/usuarios',                     ctrl.listarUsuarios);

module.exports = router;
