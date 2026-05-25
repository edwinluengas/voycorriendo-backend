require('dotenv').config();
const { Sequelize } = require('sequelize');

// Conexión directa a Supabase (sin pooler) para DDL
const sequelize = new Sequelize('postgres', 'postgres', 'Luengas1979%', {
  host: 'db.uxchuyfwxhkpjykbgahy.supabase.co',
  port: 5432,
  dialect: 'postgres',
  logging: console.log,
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
});

(async () => {
  try {
    await sequelize.authenticate();
    console.log('Conectado OK');

    await sequelize.query(`
      ALTER TABLE negocios
        ADD COLUMN IF NOT EXISTS enviado_revision_en TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS resolucion_en        TIMESTAMP WITH TIME ZONE;
    `);
    console.log('negocios OK');

    await sequelize.query(`
      ALTER TABLE repartidores
        ADD COLUMN IF NOT EXISTS enviado_revision_en TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS resolucion_en        TIMESTAMP WITH TIME ZONE;
    `);
    console.log('repartidores OK');

    await sequelize.close();
    console.log('Migracion v7 completada.');
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
})();
