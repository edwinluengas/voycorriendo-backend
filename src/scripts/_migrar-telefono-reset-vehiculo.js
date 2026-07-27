/**
 * Aplica las migraciones de esta sesión (mismas sentencias que migrarDB() en
 * server.js, idempotentes): teléfono internacional, recuperación de
 * contraseña y eliminación de bicicleta.
 */
require('dotenv').config();
const { sequelize } = require('../config/database');

const run = async (sql) => {
  try {
    await sequelize.query(sql);
    console.log('OK  ', sql.split('\n')[0].slice(0, 90));
  } catch (e) {
    console.error('FALLA', sql.split('\n')[0].slice(0, 90), '→', e.message);
    throw e;
  }
};

(async () => {
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS lada VARCHAR(5) NOT NULL DEFAULT '52'`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pais VARCHAR(2) NOT NULL DEFAULT 'MX'`);
  await run(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='usuarios' AND indexname='usuarios_lada_telefono_key') THEN
      CREATE UNIQUE INDEX usuarios_lada_telefono_key ON usuarios (lada, telefono);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='usuarios_telefono_key') THEN
      ALTER TABLE usuarios DROP CONSTRAINT usuarios_telefono_key;
    END IF;
  END $$;`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_codigo VARCHAR(100)`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_expira TIMESTAMPTZ`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_intentos SMALLINT NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE repartidores ALTER COLUMN tipo_vehiculo TYPE VARCHAR(20) USING tipo_vehiculo::text`);
  await run(`DROP TYPE IF EXISTS "enum_repartidores_tipo_vehiculo"`);
  await run(`UPDATE repartidores SET tipo_vehiculo = 'motocicleta' WHERE tipo_vehiculo = 'bicicleta'`);
  await run(`ALTER TABLE repartidores ALTER COLUMN tipo_vehiculo SET DEFAULT 'motocicleta'`);

  const q = (s) => sequelize.query(s, { type: sequelize.QueryTypes.SELECT });
  console.log('\nVerificación:');
  console.log('  índices:', (await q(`SELECT indexname FROM pg_indexes WHERE tablename='usuarios'`)).map((r) => r.indexname).join(', '));
  console.log('  vehículos:', await q(`SELECT tipo_vehiculo, COUNT(*)::int c FROM repartidores GROUP BY 1`));
  console.log('  ladas:', await q(`SELECT lada, COUNT(*)::int c FROM usuarios GROUP BY 1`));
  await sequelize.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
