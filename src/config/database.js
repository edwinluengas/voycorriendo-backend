const { Sequelize } = require('sequelize');

// Soporta dos formas:
//   1. DATABASE_URL (una sola cadena, usada por Supabase/Heroku/Render)
//   2. Variables separadas DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (local)
// Si DB_SSL=true en .env, activa SSL (necesario para Supabase/nube).

let sequelize;

if (process.env.DATABASE_URL) {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: process.env.DB_SSL === 'true' ? {
      ssl: { require: true, rejectUnauthorized: false }
    } : {},
    pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  });
} else {
  sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASSWORD,
    {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      dialect: 'postgres',
      logging: false,
      dialectOptions: process.env.DB_SSL === 'true' ? {
        ssl: { require: true, rejectUnauthorized: false }
      } : {},
      pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
    }
  );
}

// Detecta el caso comun de "Supabase direct + Railway" que falla por IPv6
const esHostDirectoSupabase = (host) => /^db\..+\.supabase\.co$/i.test(host || '');

const conectarDB = async ({ reintentos = 3, esperaMs = 3000 } = {}) => {
  const host = process.env.DB_HOST || '(via DATABASE_URL)';
  console.log(`[DB] Conectando a ${host}:${process.env.DB_PORT || '?'} ssl=${process.env.DB_SSL === 'true'}`);

  for (let intento = 1; intento <= reintentos; intento++) {
    try {
      await sequelize.authenticate();
      console.log('[DB] Conexion a PostgreSQL establecida correctamente.');
      return;
    } catch (error) {
      const msg = error?.original?.message || error.message;
      console.error(`[DB] Intento ${intento}/${reintentos} fallo: ${msg}`);

      // Pista para el caso mas comun en Railway
      if (intento === reintentos && esHostDirectoSupabase(process.env.DB_HOST)) {
        console.error('');
        console.error('AVISO: estas usando el host DIRECTO de Supabase en un entorno que tal vez');
        console.error('       no soporta IPv6 (Railway, Fly, Render sin IPv6). Cambia a Transaction Pooler:');
        console.error('         DB_HOST=aws-0-<region>.pooler.supabase.com');
        console.error('         DB_PORT=6543');
        console.error('         DB_USER=postgres.<tu-project-ref>');
        console.error('       Manten DB_SSL=true y la misma password.');
        console.error('');
      }

      if (intento < reintentos) {
        await new Promise(r => setTimeout(r, esperaMs));
      }
    }
  }

  console.error('[DB] No se pudo conectar despues de varios intentos. Saliendo.');
  process.exit(1);
};

module.exports = { sequelize, conectarDB };
