/**
 * Estado real de TODAS las conexiones externas. Solo lectura.
 */
require('dotenv').config();
const axios = require('axios'); const https = require('https');
const ag = new https.Agent({ rejectUnauthorized: false });
const ok = (b,t,d='') => console.log(`  ${b?'✅':'🚨'} ${t.padEnd(26)} ${d}`);
const P = process.env;

(async () => {
  console.log('\n═══ 1. BASE DE DATOS (Supabase / PostgreSQL) ═══');
  try {
    const { sequelize } = require('./src/config/database');
    const [r] = await sequelize.query("SELECT version() v, current_database() d", { type: sequelize.QueryTypes.SELECT });
    ok(true, 'conexión', `${r.d} · ${r.v.split(',')[0]}`);
    const [c] = await sequelize.query("SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'", { type: sequelize.QueryTypes.SELECT });
    ok(c.n > 15, 'tablas', `${c.n}`);
    await sequelize.close();
  } catch(e) { ok(false, 'conexión', e.message.slice(0,60)); }

  console.log('\n═══ 2. SUPABASE STORAGE ═══');
  try {
    const r = await axios.get(`${P.SUPABASE_URL}/storage/v1/bucket`,
      { headers:{apikey:P.SUPABASE_SERVICE_ROLE_KEY, Authorization:'Bearer '+P.SUPABASE_SERVICE_ROLE_KEY}, httpsAgent:ag, validateStatus:()=>true });
    ok(r.status===200, 'API de almacenamiento', `HTTP ${r.status} · ${(r.data||[]).length} buckets`);
    const privados = (r.data||[]).filter(b=>!b.public).map(b=>b.name);
    ok(privados.length>=3, 'buckets privados', privados.join(', '));
  } catch(e) { ok(false, 'almacenamiento', e.message.slice(0,60)); }

  console.log('\n═══ 3. MERCADO PAGO ═══');
  try {
    const r = await axios.get('https://api.mercadopago.com/users/me',
      { headers:{Authorization:'Bearer '+P.MERCADOPAGO_ACCESS_TOKEN}, httpsAgent:ag, validateStatus:()=>true });
    ok(r.status===200, 'credenciales', `cuenta ${r.data?.id} · ${r.data?.site_id}`);
    ok(r.data?.status?.sell?.allow===true, 'puede cobrar', String(r.data?.status?.sell?.allow));
    ok(P.MERCADOPAGO_ACCESS_TOKEN?.startsWith('APP_USR'), 'token de producción');
    ok(!!P.MERCADOPAGO_WEBHOOK_SECRET, 'secreto del webhook', P.MERCADOPAGO_WEBHOOK_SECRET?'configurado':'FALTA');
  } catch(e) { ok(false, 'Mercado Pago', e.message.slice(0,60)); }

  console.log('\n═══ 4. GOOGLE MAPS ═══');
  try {
    const activo = require('./src/config/mapas');
    ok(true, 'interruptor', JSON.stringify(activo.GOOGLE_MAPS_ACTIVO ?? activo));
    const r = await axios.post('https://routes.googleapis.com/directions/v2:computeRoutes',
      { origin:{location:{latLng:{latitude:15.8631,longitude:-97.0676}}},
        destination:{location:{latLng:{latitude:15.8650,longitude:-97.0700}}}, travelMode:'DRIVE' },
      { headers:{'X-Goog-Api-Key':P.GOOGLE_MAPS_API_KEY,'X-Goog-FieldMask':'routes.distanceMeters'},
        httpsAgent:ag, validateStatus:()=>true, timeout:20000 });
    ok(r.status===200, 'Routes API', r.status===200 ? `${r.data?.routes?.[0]?.distanceMeters} m` : JSON.stringify(r.data).slice(0,70));
  } catch(e) { ok(false, 'Google Maps', e.message.slice(0,60)); }

  console.log('\n═══ 5. CORREO ═══');
  ok(!!(P.RESEND_API_KEY || P.SMTP_HOST), 'proveedor', P.RESEND_API_KEY ? 'Resend' : (P.SMTP_HOST || 'NINGUNO'));

  console.log('\n═══ 6. TELEGRAM ═══');
  if (P.TELEGRAM_BOT_TOKEN) {
    const r = await axios.get(`https://api.telegram.org/bot${P.TELEGRAM_BOT_TOKEN}/getMe`, {httpsAgent:ag, validateStatus:()=>true});
    ok(r.status===200, 'bot', r.data?.result?.username || JSON.stringify(r.data).slice(0,50));
    ok(!!P.TELEGRAM_ADMIN_CHAT_ID, 'chat del admin', P.TELEGRAM_ADMIN_CHAT_ID ? 'configurado' : 'FALTA');
  } else ok(false, 'bot', 'sin TELEGRAM_BOT_TOKEN');

  console.log('\n═══ 7. TWILIO (SMS) ═══');
  ok(!!P.TWILIO_ACCOUNT_SID, 'credenciales', P.TWILIO_ACCOUNT_SID ? 'configuradas' : 'sin configurar');

  console.log('\n═══ 8. SECRETOS CRÍTICOS ═══');
  ok((P.JWT_SECRET||'').length >= 32, 'JWT_SECRET', `${(P.JWT_SECRET||'').length} caracteres`);
  ok((P.CLABE_ENCRYPTION_KEY||'').length === 64, 'clave de cifrado CLABE', `${(P.CLABE_ENCRYPTION_KEY||'').length} (debe ser 64 hex)`);
})();
