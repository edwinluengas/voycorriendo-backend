/**
 * Freno de gasto propio para las llamadas facturables a Google Maps.
 *
 * Por qué existe: las cuotas de la consola de Google topan la CANTIDAD de
 * solicitudes, no el DINERO — no hay forma nativa de decir "no gastes más
 * de X dólares y apaga". Esta es la segunda capa, dentro del código, para
 * no depender de que alguien se acuerde de revisar la consola.
 *
 * Cómo funciona: cada llamada se RESERVA antes de salir a la red
 * (incremento atómico que devuelve el nuevo total). Si la reserva pasa el
 * límite, no se llama a Google y el sistema cae al cálculo local — el
 * pedido nunca falla, solo pierde precisión de ruta ese día.
 *
 * Se reserva ANTES en vez de contar DESPUÉS a propósito: con varias
 * peticiones simultáneas, contar después deja pasar de más justo en el
 * borde, que es cuando importa.
 */
const { Sequelize } = require('sequelize');
const { sequelize } = require('../config/database');

// Se leen en cada llamada, no al cargar el módulo: así cambiar el tope en
// Railway surte efecto al reiniciar sin recompilar nada, y los tests pueden
// probar distintos límites sin recargar módulos (recargar duplicaba el pool
// de conexiones a Postgres).
const limiteDiario  = () => parseInt(process.env.GOOGLE_MAPS_LIMITE_DIARIO  || '800', 10);
// 10.000 llamadas al mes es el tramo sin costo de Routes API (Essentials).
// El default deja margen para no rozarlo nunca.
const limiteMensual = () => parseInt(process.env.GOOGLE_MAPS_LIMITE_MENSUAL || '9500', 10);

// Cuando ya se topó, se recuerda en memoria para no castigar la DB con una
// consulta por request durante el resto del día.
let bloqueadoHasta = null;

const q = (sql, replacements) =>
  sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT, replacements });

const finDelDiaUTC = () => {
  const d = new Date();
  d.setUTCHours(23, 59, 59, 999);
  return d;
};

/**
 * Reserva una llamada. Devuelve true solo si queda cuota.
 * Ante CUALQUIER error (DB caída, tabla ausente) devuelve false: si no se
 * puede contar el gasto, no se gasta. Es dinero — se falla del lado seguro.
 */
const reservarLlamada = async () => {
  if (bloqueadoHasta && Date.now() < bloqueadoHasta) return false;

  try {
    const [fila] = await q(
      `INSERT INTO google_api_uso (dia, llamadas)
            VALUES (CURRENT_DATE, 1)
       ON CONFLICT (dia) DO UPDATE SET llamadas = google_api_uso.llamadas + 1
         RETURNING llamadas`,
    );
    const hoy = Number(fila?.llamadas || 0);

    const topeDiario = limiteDiario();
    if (hoy > topeDiario) {
      await avisarTope('diario', hoy, topeDiario);
      bloqueadoHasta = finDelDiaUTC().getTime();
      return false;
    }

    // El mensual solo se revisa cerca del corte: no vale una consulta extra
    // por cada llamada cuando el mes va por la mitad del cupo.
    if (hoy % 25 === 0 || hoy > topeDiario * 0.8) {
      const [mes] = await q(
        `SELECT COALESCE(SUM(llamadas), 0) AS total FROM google_api_uso
          WHERE dia >= date_trunc('month', CURRENT_DATE)`,
      );
      const total = Number(mes?.total || 0);
      const topeMensual = limiteMensual();
      if (total > topeMensual) {
        await avisarTope('mensual', total, topeMensual);
        bloqueadoHasta = finDelDiaUTC().getTime();
        return false;
      }
    }

    return true;
  } catch (e) {
    console.error('[cuotaGoogle] No se pudo contabilizar la llamada, se usa el cálculo local:', e.message);
    return false;
  }
};

// Avisa UNA vez por día y por tipo de tope. La marca vive en la DB para que
// un redeploy no vuelva a mandar la misma alerta.
const avisarTope = async (tipo, usadas, limite) => {
  // La suite prueba el freno bajando el límite a 2, y corre contra la base
  // REAL con el token REAL de Telegram: sin esto, cada corrida le manda al
  // dueño una alerta de "tope alcanzado" que no está pasando. Una alerta que
  // grita en falso enseña a ignorar las que sí importan.
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return;

  const columna = tipo === 'diario' ? 'alertado_diario' : 'alertado_mensual';
  try {
    const filas = await q(
      `UPDATE google_api_uso SET ${columna} = true
        WHERE dia = CURRENT_DATE AND ${columna} = false
        RETURNING dia`,
    );
    if (!filas.length) return;   // ya se avisó hoy

    const msg = `⚠️ <b>Tope ${tipo} de Google Maps alcanzado</b>\n\n`
      + `Llamadas: <b>${usadas}</b> / ${limite}\n\n`
      + `A partir de ahora las rutas y distancias se calculan en local `
      + `(línea recta corregida). Los pedidos siguen funcionando normal, `
      + `solo se pierde precisión hasta que se reinicie el contador.`;
    console.warn(`[cuotaGoogle] TOPE ${tipo.toUpperCase()}: ${usadas}/${limite} — se usa cálculo local.`);
    const tg = require('./telegram.service');
    await tg.enviarAdmin(msg).catch(() => {});
  } catch (e) {
    console.error('[cuotaGoogle] Falló el aviso de tope:', e.message);
  }
};

/** Consumo actual — para el panel de admin y para diagnóstico. */
const consumo = async () => {
  try {
    const [hoy] = await q(
      `SELECT COALESCE(llamadas, 0) AS n FROM google_api_uso WHERE dia = CURRENT_DATE`,
    );
    const [mes] = await q(
      `SELECT COALESCE(SUM(llamadas), 0) AS n FROM google_api_uso
        WHERE dia >= date_trunc('month', CURRENT_DATE)`,
    );
    return {
      hoy: Number(hoy?.n || 0),
      mes: Number(mes?.n || 0),
      limite_diario: limiteDiario(),
      limite_mensual: limiteMensual(),
    };
  } catch {
    return null;
  }
};

// Para los tests: olvida el bloqueo cacheado en memoria.
const _resetCache = () => { bloqueadoHasta = null; };

module.exports = { reservarLlamada, consumo, limiteDiario, limiteMensual, _resetCache };
