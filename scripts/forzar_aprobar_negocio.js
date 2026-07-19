require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, ssl: { require: true, rejectUnauthorized: false },
  });
  await client.connect();

  // Verificar qué valores acepta el enum
  const { rows: enumVals } = await client.query(`
    SELECT e.enumlabel FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname LIKE '%verificacion%' OR t.typname LIKE '%estado%'
    ORDER BY t.typname, e.enumsortorder
  `);
  console.log('Enum values:', enumVals.map(r => r.enumlabel).join(', '));

  // Forzar update con cast explícito
  const result = await client.query(`
    UPDATE negocios
    SET verificacion_estado = 'aprobado'::text::verificacion_estado_enum,
        bloqueado_por_deuda = false,
        aprobado_en = NOW()
    WHERE id = '04660a1d-b26b-46ff-b03f-0b2215ab3d46'
    RETURNING id, verificacion_estado
  `);
  console.log('Update result:', result.rows);

  await client.end();
}

main().catch(async e => {
  console.error('[ERROR]', e.message);
  // Si falla el cast, intentar con texto plano
  const client2 = new Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, ssl: { require: true, rejectUnauthorized: false },
  });
  await client2.connect();

  // Verificar el nombre real del tipo enum
  const { rows } = await client2.query(`
    SELECT column_name, udt_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'negocios' AND column_name = 'verificacion_estado'
  `);
  console.log('Column info:', rows);

  await client2.end();
  process.exit(1);
});
