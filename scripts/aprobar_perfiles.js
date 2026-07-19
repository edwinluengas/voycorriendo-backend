require('dotenv').config();
const { Client } = require('pg');

const TELEFONO = '5545074460';

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { require: true, rejectUnauthorized: false },
  });

  await client.connect();

  const { rows: usuarios } = await client.query(
    'SELECT id, nombre FROM usuarios WHERE telefono = $1',
    [TELEFONO]
  );
  if (!usuarios.length) { console.log('Usuario no encontrado.'); await client.end(); return; }
  const { id: uid, nombre } = usuarios[0];
  console.log(`Usuario: ${nombre} (${uid})`);

  // Activar cuenta del usuario
  await client.query(
    `UPDATE usuarios SET estado = 'activo', telefono_verificado = true WHERE id = $1`,
    [uid]
  );
  console.log('[OK] Usuario activado');

  // Aprobar repartidor
  const { rowCount: repCount } = await client.query(
    `UPDATE repartidores SET verificacion_estado = 'aprobado', estado_cuenta = 'normal' WHERE usuario_id = $1`,
    [uid]
  );
  console.log(`[OK] Repartidor aprobado (${repCount} fila(s))`);

  // Aprobar negocio
  const { rowCount: negCount } = await client.query(
    `UPDATE negocios SET verificacion_estado = 'aprobado'::enum_verificacion_negocio, activo = true, bloqueado_por_deuda = false WHERE usuario_id = $1`,
    [uid]
  );
  console.log(`[OK] Negocio aprobado (${negCount} fila(s))`);

  await client.end();
  console.log('\n✅ Todos los perfiles aprobados.');
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
