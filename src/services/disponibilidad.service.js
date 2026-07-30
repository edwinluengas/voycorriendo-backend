/**
 * ¿Hay quién entregue ahora mismo? — VoyCorriendo
 * ------------------------------------------------------------------
 * Antes de ofrecerle envío a domicilio a un cliente hay que saber si existe
 * al menos un repartidor que pueda tomarlo. Sin esta verificación el pedido
 * entra, el negocio lo prepara, y se queda en 'listo' hasta que el job de
 * timeout lo cancela — la peor experiencia posible para las tres partes.
 *
 * "Puede tomarlo" = aprobado + conectado + cuenta sin restricción + de la
 * misma ciudad + CON CUPO en su ruta (un repartidor con 3 pedidos encima ya
 * no puede aceptar otro, así que estar conectado no basta).
 */
const { sequelize } = require('../config/database');

const ESTADOS_TERMINALES = ['entregado', 'cancelado', 'rechazado'];

// Mensajes al cliente cuando solo queda pickup. NO se dice "no hay
// repartidores": se enmarca como beneficio (ahorras el envío, es inmediato),
// que es lo que el dueño pidió. Se rota por pedido para que no se sienta
// como un error del sistema repetido.
const MENSAJES_SOLO_PICKUP = [
  '⚡ Hoy la entrega a domicilio va a tope. Pasa por tu pedido y te ahorras el envío.',
  '🛍️ Recoge y ahorra: pide, pasa por tu pedido y no pagas envío.',
  '🔥 Mucha demanda en este momento. Recógelo en tienda: sale más rápido y sin costo de envío.',
];

const mensajeSoloPickup = (semilla = 0) =>
  MENSAJES_SOLO_PICKUP[Math.abs(semilla) % MENSAJES_SOLO_PICKUP.length];

/**
 * @param {string} ciudad  ciudad del negocio/pedido
 * @returns {{ disponible: boolean, conectados: number, con_cupo: number }}
 */
const hayRepartidoresParaEnvio = async (ciudad = 'puerto_escondido') => {
  try {
    const [fila] = await sequelize.query(
      `SELECT
         COUNT(*)::int AS conectados,
         COUNT(*) FILTER (WHERE pendientes < COALESCE(r.max_pedidos_ruta, 3))::int AS con_cupo
       FROM repartidores r
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS pendientes
           FROM pedidos p
          WHERE p.repartidor_id = r.id
            AND p.estado NOT IN (:terminales)
       ) AS carga
       WHERE r.verificacion_estado = 'aprobado'
         AND r.conectado = true
         AND COALESCE(r.estado_cuenta, 'normal') NOT IN ('suspendido', 'bloqueado')
         AND COALESCE(r.baja_permanente, false) = false
         AND (r.ciudad IS NULL OR r.ciudad = :ciudad)`,
      { type: sequelize.QueryTypes.SELECT, replacements: { ciudad, terminales: ESTADOS_TERMINALES } },
    );
    const conectados = fila?.conectados || 0;
    const conCupo    = fila?.con_cupo || 0;
    return { disponible: conCupo > 0, conectados, con_cupo: conCupo };
  } catch (e) {
    // Si la consulta falla, se asume que SÍ hay servicio: es mejor aceptar un
    // pedido a domicilio (recuperable: el job de timeout lo cancela y avisa)
    // que apagarle el envío a toda la ciudad por un error de base de datos.
    console.error('[disponibilidad] No se pudo evaluar repartidores en línea:', e.message);
    return { disponible: true, conectados: null, con_cupo: null, error: true };
  }
};

module.exports = { hayRepartidoresParaEnvio, mensajeSoloPickup, MENSAJES_SOLO_PICKUP };
