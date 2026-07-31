/**
 * Deja el envío de correo funcionando en un solo comando.
 *
 *   node src/scripts/configurar-correo.js "abcd efgh ijkl mnop"        (Gmail)
 *   node src/scripts/configurar-correo.js --resend re_XXXXXXXX         (Resend)
 *   node src/scripts/configurar-correo.js --probar                     (solo probar)
 *
 * Con Gmail hace falta una CONTRASEÑA DE APLICACIÓN (16 letras), no la
 * contraseña normal de la cuenta: se crea en myaccount.google.com/security
 * → Contraseñas de aplicaciones (requiere verificación en dos pasos activa).
 * Se puede revocar cuando sea, sin tocar la contraseña real del correo.
 *
 * El script: configura las variables locales y en Railway, manda un correo
 * de prueba de verdad y solo entonces reporta éxito.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CUENTA_GMAIL = process.env.EMAIL_REMITENTE || 'voycorriendoadmin@gmail.com';
const rutaEnv = path.join(__dirname, '..', '..', '.env');

const args = process.argv.slice(2);
const soloProbar = args.includes('--probar');
const esResend = args.includes('--resend');
const valor = args.filter((a) => !a.startsWith('--')).join(' ').trim();

// Las variables se escriben en .env (local) y en Railway (producción), para
// que probar en local y en producción no requiera pasos distintos.
const escribirEnv = (pares) => {
  let env = fs.existsSync(rutaEnv) ? fs.readFileSync(rutaEnv, 'utf8') : '';
  for (const [clave, val] of Object.entries(pares)) {
    const linea = `${clave}=${val}`;
    env = new RegExp(`^${clave}=.*$`, 'm').test(env)
      ? env.replace(new RegExp(`^${clave}=.*$`, 'm'), linea)
      : `${env.trimEnd()}\n${linea}\n`;
  }
  fs.writeFileSync(rutaEnv, env);
};

const escribirRailway = (pares) => {
  const flags = Object.entries(pares).map(([k, v]) => `--set "${k}=${v}"`).join(' ');
  try {
    execSync(`railway variables --service voycorriendo-backend ${flags} --skip-deploys`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.warn('⚠️  No se pudieron escribir las variables en Railway:', e.message.split('\n')[0]);
    console.warn('    Configúralas a mano en el panel de Railway con los mismos nombres.');
    return false;
  }
};

(async () => {
  if (!soloProbar) {
    if (!valor) {
      console.log('Falta la credencial.\n');
      console.log('  Gmail : node src/scripts/configurar-correo.js "abcd efgh ijkl mnop"');
      console.log('  Resend: node src/scripts/configurar-correo.js --resend re_XXXXXXXX');
      process.exit(1);
    }

    if (esResend) {
      const pares = { RESEND_API_KEY: valor };
      escribirEnv(pares); escribirRailway(pares);
      process.env.RESEND_API_KEY = valor;
      console.log('✅ Resend configurado.');
      console.log('   OJO: Resend solo entrega a terceros con un DOMINIO verificado.');
      console.log('   Sin dominio propio solo podrás mandarte correos a ti mismo.');
    } else {
      // Gmail acepta la contraseña de aplicación con o sin espacios; se
      // quitan porque Google la muestra en grupos de 4 solo para leerla.
      const password = valor.replace(/\s+/g, '');
      if (password.length !== 16) {
        console.log(`⚠️  Una contraseña de aplicación de Google tiene 16 letras; esta tiene ${password.length}.`);
        console.log('   Si pegaste la contraseña normal de tu correo, NO va a funcionar:');
        console.log('   hay que crear una en myaccount.google.com/security → Contraseñas de aplicaciones.');
      }
      const pares = {
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_PORT: '587',
        SMTP_USER: CUENTA_GMAIL,
        SMTP_PASS: password,
        EMAIL_FROM: `VoyCorriendo <${CUENTA_GMAIL}>`,
      };
      escribirEnv(pares); escribirRailway(pares);
      Object.assign(process.env, pares);
      console.log(`✅ Correo configurado con ${CUENTA_GMAIL}`);
    }
  }

  // ── Prueba REAL: si no llega, no está configurado ──
  const { enviarEmail, emailConfigurado } = require('../services/email.service');
  console.log('\nProveedor detectado:', emailConfigurado() ? 'sí' : 'NO — falta configurar');
  if (!emailConfigurado()) process.exit(1);

  const destino = process.env.EMAIL_PRUEBA || CUENTA_GMAIL;
  console.log(`Enviando correo de prueba a ${destino}…`);
  const r = await enviarEmail({
    para: destino,
    asunto: 'VoyCorriendo — prueba de envío de correo',
    texto: 'Si estás leyendo esto, el envío de correo de VoyCorriendo quedó funcionando. '
         + 'Con esto tus clientes ya pueden recuperar su contraseña.',
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;padding:24px">
      <h2 style="color:#FF5C00;margin:0 0 8px">VoyCorriendo</h2>
      <p style="font-size:15px;color:#111827">Si estás leyendo esto, el envío de correo quedó funcionando.</p>
      <p style="font-size:13px;color:#6B7280">Con esto tus clientes ya pueden recuperar su contraseña desde la app.</p>
    </div>`,
  });

  if (r.ok) {
    console.log(`\n✅ Correo entregado por ${r.proveedor}. Revisa la bandeja de ${destino}.`);
    console.log('   Si no aparece en unos minutos, mira también en Spam.');
    if (!soloProbar) console.log('\n   Falta un paso: reiniciar el servicio en Railway para que tome las variables.');
  } else {
    console.log(`\n❌ No se pudo enviar: ${r.motivo}${r.detalle ? ' — ' + r.detalle : ''}`);
    if (String(r.detalle || '').includes('Username and Password not accepted')) {
      console.log('   Google rechazó la credencial: casi siempre es la contraseña normal en vez de');
      console.log('   una CONTRASEÑA DE APLICACIÓN, o la verificación en dos pasos está apagada.');
    }
    process.exit(1);
  }
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
