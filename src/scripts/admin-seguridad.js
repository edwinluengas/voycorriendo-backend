/**
 * Herramienta de recuperación y control de cuentas administrador.
 *
 * Es la ÚNICA salida si un admin se queda fuera: la API no tiene ningún
 * bypass del segundo factor a propósito. Correr esto exige acceso a la base
 * de producción (o sea, al dueño), que es justo el punto.
 *
 * Uso:
 *   node src/scripts/admin-seguridad.js listar
 *   node src/scripts/admin-seguridad.js <telefono> estado
 *   node src/scripts/admin-seguridad.js <telefono> desbloquear
 *   node src/scripts/admin-seguridad.js <telefono> 2fa-off      (desactiva el 2FA — solo emergencias)
 *   node src/scripts/admin-seguridad.js <telefono> 2fa-on
 *   node src/scripts/admin-seguridad.js <telefono> cerrar-sesiones
 *   node src/scripts/admin-seguridad.js <telefono> quitar-admin (degrada la cuenta a cliente)
 *   node src/scripts/admin-seguridad.js bitacora [n]            (últimos n eventos de auth)
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const Usuario = require('../models/Usuario');
const { normalizarTelefono } = require('../utils/telefono');

const [arg1, arg2, arg3] = process.argv.slice(2);

const buscar = async (telefonoCrudo) => {
  const { lada, telefono } = normalizarTelefono(telefonoCrudo, undefined);
  const usuario = await Usuario.findOne({ where: { telefono, lada } })
    || await Usuario.findOne({ where: { telefono } });
  if (!usuario) throw new Error(`No existe ninguna cuenta con el teléfono ${telefonoCrudo}.`);
  return usuario;
};

const resumen = (u) => ({
  telefono: `+${u.lada} ${u.telefono}`,
  nombre: `${u.nombre} ${u.apellido || ''}`.trim(),
  rol: u.rol,
  estado: u.estado,
  '2fa_activo': u.admin_2fa_activo,
  intentos_fallidos: u.intentos_fallidos,
  bloqueado_hasta: u.bloqueado_hasta,
  telegram_vinculado: !!u.telegram_chat_id,
  email: u.email || '—',
  ultimo_login_ip: u.ultimo_login_ip || '—',
  ultima_conexion: u.ultima_conexion,
});

(async () => {
  if (!arg1 || arg1 === 'ayuda' || arg1 === '--help') {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }

  if (arg1 === 'listar') {
    const admins = await Usuario.findAll({ where: { rol: 'admin' }, order: [['creado_en', 'ASC']] });
    console.log(`${admins.length} cuenta(s) administrador:`);
    admins.forEach((u) => console.log(resumen(u)));
    return;
  }

  if (arg1 === 'bitacora') {
    const limite = Number(arg2) || 20;
    const filas = await sequelize.query(
      `SELECT a.creado_en, a.accion, a.ip, a.estado_despues, u.telefono, u.nombre
         FROM audit_logs a LEFT JOIN usuarios u ON u.id = a.admin_id
        WHERE a.entidad_tipo IN ('auth', 'admin_api')
        ORDER BY a.creado_en DESC LIMIT :limite`,
      { type: sequelize.QueryTypes.SELECT, replacements: { limite } },
    );
    filas.forEach((f) => console.log(
      `${f.creado_en.toISOString()} | ${String(f.accion).padEnd(24)} | ${f.nombre || '—'} (${f.telefono || '—'}) | IP ${f.ip || '—'} | ${JSON.stringify(f.estado_despues || {})}`));
    return;
  }

  const usuario = await buscar(arg1);
  const accion = arg2;

  switch (accion) {
    case 'estado':
      console.log(resumen(usuario));
      break;

    case 'desbloquear':
      await usuario.update({ intentos_fallidos: 0, bloqueado_hasta: null, login2fa_intentos: 0 });
      console.log('✅ Cuenta desbloqueada.', resumen(usuario));
      break;

    case '2fa-off':
      if (usuario.rol !== 'admin') { console.log('Esta cuenta no es admin — el 2FA no aplica.'); break; }
      await usuario.update({ admin_2fa_activo: false, login2fa_codigo: null, login2fa_expira: null });
      console.log('⚠️  SEGUNDO FACTOR DESACTIVADO para esta cuenta admin.');
      console.log('   Es un candado menos: vuelve a activarlo (2fa-on) en cuanto recuperes tu canal de códigos.');
      break;

    case '2fa-on':
      await usuario.update({ admin_2fa_activo: true });
      console.log('✅ Segundo factor activado.', resumen(usuario));
      break;

    case 'cerrar-sesiones':
      await usuario.update({ token_version: (usuario.token_version ?? 0) + 1 });
      console.log('✅ Todas las sesiones abiertas de esta cuenta quedaron invalidadas.');
      break;

    case 'quitar-admin':
      if (usuario.rol !== 'admin') { console.log('Esta cuenta no es admin.'); break; }
      await usuario.update({
        rol: 'cliente',
        modo_activo: 'cliente',
        token_version: (usuario.token_version ?? 0) + 1,   // corta sus sesiones vivas
      });
      console.log('✅ Cuenta degradada a cliente y sesiones cerradas.', resumen(usuario));
      break;

    default:
      console.log(`Acción desconocida: "${accion}". Corre sin argumentos para ver la ayuda.`);
  }
})()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
