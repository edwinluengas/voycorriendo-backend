/**
 * Solo lectura: fotografía de cómo están repartidas las plazas en la base real.
 * No modifica nada. `node src/scripts/_auditar-plazas.js`
 */
require('dotenv').config();
const { sequelize } = require('../config/database');

const q = async (sql) => sequelize.query(sql, { type: sequelize.QueryTypes.SELECT });

(async () => {
  try {
    console.log('\n── NEGOCIOS por ciudad ──');
    console.table(await q(`
      SELECT COALESCE(ciudad,'(null)') AS ciudad, verificacion_estado, activo,
             COUNT(*)::int AS n,
             SUM(CASE WHEN latitud IS NULL OR longitud IS NULL THEN 1 ELSE 0 END)::int AS sin_gps
      FROM negocios GROUP BY 1,2,3 ORDER BY 1,2`));

    console.log('\n── NEGOCIOS (detalle) ──');
    console.table(await q(`
      SELECT nombre, COALESCE(ciudad,'(null)') AS ciudad, colonia,
             latitud::float, longitud::float, verificacion_estado, activo
      FROM negocios ORDER BY ciudad, nombre`));

    console.log('\n── REPARTIDORES por ciudad ──');
    console.table(await q(`
      SELECT COALESCE(ciudad,'(null)') AS ciudad, verificacion_estado,
             COUNT(*)::int AS n,
             SUM(CASE WHEN conectado THEN 1 ELSE 0 END)::int AS conectados,
             SUM(CASE WHEN latitud IS NULL THEN 1 ELSE 0 END)::int AS sin_gps
      FROM repartidores GROUP BY 1,2 ORDER BY 1`));

    console.log('\n── REPARTIDORES (detalle) ──');
    console.table(await q(`
      SELECT r.id, COALESCE(r.ciudad,'(null)') AS ciudad, r.verificacion_estado,
             r.conectado, r.latitud::float, r.longitud::float
      FROM repartidores r ORDER BY r.ciudad`));

    console.log('\n── PEDIDOS por ciudad ──');
    console.table(await q(`
      SELECT COALESCE(ciudad,'(null)') AS ciudad, estado, COUNT(*)::int AS n
      FROM pedidos GROUP BY 1,2 ORDER BY 1,2`));

    console.log('\n── USUARIOS: ¿existe columna ciudad? ──');
    console.table(await q(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name IN ('usuarios','negocios','repartidores','pedidos')
        AND column_name = 'ciudad' ORDER BY table_name`));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await sequelize.close();
  }
})();
