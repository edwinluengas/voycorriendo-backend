const { sequelize } = require('../config/database');

/**
 * Registra una acción de admin en audit_logs.
 * Nunca lanza error — falla silenciosa para no interrumpir la respuesta.
 */
const logAdmin = async ({ adminId, accion, entidadTipo, entidadId = null, estadoAntes = null, estadoDespues = null, ip = null }) => {
  try {
    await sequelize.query(
      `INSERT INTO audit_logs (admin_id, accion, entidad_tipo, entidad_id, estado_antes, estado_despues, ip)
       VALUES (:adminId, :accion, :entidadTipo, :entidadId, :antes::jsonb, :despues::jsonb, :ip)`,
      {
        replacements: {
          adminId,
          accion,
          entidadTipo,
          entidadId,
          antes:   estadoAntes   ? JSON.stringify(estadoAntes)   : null,
          despues: estadoDespues ? JSON.stringify(estadoDespues) : null,
          ip,
        },
      }
    );
  } catch (e) {
    console.warn('[audit] Error al registrar acción:', e.message);
  }
};

module.exports = { logAdmin };
