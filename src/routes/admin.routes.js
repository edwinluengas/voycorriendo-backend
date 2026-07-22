/**
 * Rutas del Panel de Administracion.
 *
 * TODAS protegidas por: proteger + restringirA('admin').
 * Solo usuarios con rol = 'admin' pueden tocarlas.
 */
const express = require('express');
const { proteger, restringirA } = require('../middleware/auth');
const ctrl = require('../controllers/adminController');
const speiCtrl = require('../controllers/speiController');

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
router.post  ('/repartidores/:id/confirmar-retiro', ctrl.confirmarRetiroRepartidor);

// ─── Negocios ───────────────────────────────────────────────
router.get   ('/negocios',                     ctrl.listarNegocios);
router.get   ('/negocios/:id',                 ctrl.obtenerNegocio);
router.patch ('/negocios/:id/aprobar',         ctrl.aprobarNegocio);
router.patch ('/negocios/:id/rechazar',        ctrl.rechazarNegocio);
router.patch ('/negocios/:id/cuenta',          ctrl.cambiarEstadoCuentaNegocio);
router.post  ('/negocios/:id/confirmar-pago',  ctrl.confirmarPagoDeuda);
router.post  ('/negocios/:id/liquidar-semanal', ctrl.liquidarSemanalNegocio);

// ─── Pedidos ──────────────────────────────────────────────────
router.patch ('/pedidos/:id/confirmar-pago',   ctrl.confirmarPagoPedido);

// ─── Usuarios (busqueda) ────────────────────────────────────
router.get   ('/usuarios',                     ctrl.listarUsuarios);

// ─── Bloqueos permanentes (placas/direcciones vetadas) ──────
router.get   ('/bloqueos-permanentes',         ctrl.listarBloqueosPermanentes);
router.delete('/bloqueos-permanentes/:id',     ctrl.eliminarBloqueoPermanente);

// ─── Pagos SPEI ──────────────────────────────────────────────
router.get  ('/pagos/spei/pendientes', speiCtrl.pendientes);
router.post ('/pagos/spei/ejecutar',   speiCtrl.ejecutar);

// ─── Revenue reporting ───────────────────────────────────────
router.get  ('/revenue', ctrl.revenueReport);

module.exports = router;
