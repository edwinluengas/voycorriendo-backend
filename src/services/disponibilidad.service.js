/**
 * ¿Hay quién entregue ahora mismo? — VoyCorriendo
 * ------------------------------------------------------------------
 * Antes de ofrecerle envío a domicilio a un cliente hay que saber si existe
 * al menos un repartidor que pueda tomarlo. Sin esta verificación el pedido
 * entra, el negocio lo prepara, y se queda en 'listo' hasta que el job de
 * timeout lo cancela — la peor experiencia posible para las tres partes.
 *
 * "Puede tomarlo" = aprobado + conectado + CON SEÑAL DE VIDA RECIENTE +
 * cuenta sin restricción + de la misma ciudad + CON CUPO en su ruta.
 *
 * El "latido" es la pieza que faltaba y costó un pedido real (MND-151740,
 * 2026-07-30): la cuenta de un repartidor llevaba `conectado = true` desde
 * hacía CINCO DÍAS — prendió el switch y cerró la app. El sistema veía un
 * repartidor disponible, aceptó un pedido a domicilio y nadie fue a
 * recogerlo. Estar marcado como conectado no prueba nada; lo que prueba que
 * alguien está trabajando es que su app siga hablando con el servidor.
 */
const { sequelize } = require('../config/database');

const ESTADOS_TERMINALES = ['entregado', 'cancelado', 'rechazado'];

// Lee una variable de entorno como número, o usa el default
const num = (clave, def) => {
  const raw = process.env[clave];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

// Ventana de actividad: un repartidor cuenta como disponible solo si dio
// señales de vida dentro de este rango. La app de quien está trabajando
// consulta pedidos cada 10 s, así que cualquier valor de este orden distingue
// perfectamente "trabajando" de "prendió el switch y se fue".
const LATIDO_MAX_MIN = num('LATIDO_REPARTIDOR_MIN', 120);   // 2 horas
// Además, un job apaga el switch de quien lleva este tiempo callado, para que
// su propia pantalla también diga la verdad (ver jobs/pedidoTimeout.job.js).
const LATIDO_DESCONECTAR_MIN = num('LATIDO_DESCONECTAR_MIN', 20);

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
         COUNT(*)::int AS marcados_conectados,
         COUNT(*) FILTER (WHERE activo_reciente)::int AS activos,
         COUNT(*) FILTER (WHERE activo_reciente AND pendientes < COALESCE(r.max_pedidos_ruta, 3))::int AS con_cupo
       FROM repartidores r
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS pendientes
           FROM pedidos p
          WHERE p.repartidor_id = r.id
            AND p.estado NOT IN (:terminales)
       ) AS carga
       CROSS JOIN LATERAL (
         -- Señal de vida: su app habló con el servidor hace poco. Sin esto,
         -- un switch olvidado en "conectado" hacía creer que había servicio.
         SELECT (r.ultimo_latido IS NOT NULL
                 AND r.ultimo_latido > NOW() - (:latidoMin || ' minutes')::interval) AS activo_reciente
       ) AS vida
       WHERE r.verificacion_estado = 'aprobado'
         AND r.conectado = true
         AND COALESCE(r.estado_cuenta, 'normal') NOT IN ('suspendido', 'bloqueado')
         AND COALESCE(r.baja_permanente, false) = false
         AND (r.ciudad IS NULL OR r.ciudad = :ciudad)`,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { ciudad, terminales: ESTADOS_TERMINALES, latidoMin: String(LATIDO_MAX_MIN) },
      },
    );
    const marcados = fila?.marcados_conectados || 0;
    const activos  = fila?.activos || 0;
    const conCupo  = fila?.con_cupo || 0;
    if (marcados > activos) {
      console.warn(`[disponibilidad] ${marcados - activos} repartidor(es) con el switch en "conectado" pero sin actividad en ${LATIDO_MAX_MIN} min — no cuentan como disponibles.`);
    }
    return { disponible: conCupo > 0, conectados: activos, marcados_conectados: marcados, con_cupo: conCupo };
  } catch (e) {
    // Si la consulta falla, se asume que SÍ hay servicio: es mejor aceptar un
    // pedido a domicilio (recuperable: el job de timeout lo cancela y avisa)
    // que apagarle el envío a toda la ciudad por un error de base de datos.
    console.error('[disponibilidad] No se pudo evaluar repartidores en línea:', e.message);
    return { disponible: true, conectados: null, con_cupo: null, error: true };
  }
};

// ─── Latido de actividad del repartidor ───────────────────
// Se llama en CUALQUIER request autenticado de un repartidor (middleware en
// repartidores.routes) y en cada actualización de ubicación por socket. No se
// espera el resultado: es telemetría, no debe frenar la respuesta ni tumbarla.
const registrarLatido = (repartidorId) => {
  if (!repartidorId) return;
  sequelize.query(
    `UPDATE repartidores SET ultimo_latido = NOW() WHERE id = :id`,
    { replacements: { id: repartidorId } },
  ).catch((e) => console.warn('[disponibilidad] no se pudo registrar el latido:', e.message));
};

// Apaga el switch de los repartidores que llevan callados demasiado tiempo.
// Devuelve cuántos se desconectaron. Lo corre el job cada 5 min.
const desconectarInactivos = async () => {
  try {
    const [filas] = await sequelize.query(
      `UPDATE repartidores
          SET conectado = false
        WHERE conectado = true
          AND (ultimo_latido IS NULL OR ultimo_latido < NOW() - (:min || ' minutes')::interval)
        RETURNING id`,
      { replacements: { min: String(LATIDO_DESCONECTAR_MIN) } },
    );
    return filas?.length || 0;
  } catch (e) {
    console.error('[disponibilidad] error desconectando inactivos:', e.message);
    return 0;
  }
};

module.exports = {
  hayRepartidoresParaEnvio, mensajeSoloPickup, MENSAJES_SOLO_PICKUP,
  registrarLatido, desconectarInactivos,
  LATIDO_MAX_MIN, LATIDO_DESCONECTAR_MIN,
};
