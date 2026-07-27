/**
 * Prueba end-to-end del canje de código de recuperación contra el servidor
 * local. El ENVÍO real (SMS/email) se prueba aparte — aquí se siembra un
 * código conocido en la DB (hasheado igual que lo hace el controlador) y se
 * verifica: código malo → rechazo, código bueno → contraseña cambiada,
 * sesiones viejas invalidadas, y login con la contraseña nueva.
 */
require('dotenv').config();
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');
const Usuario = require('../models/Usuario');

const API = process.env.API_PRUEBA || 'http://localhost:3999/api';
const TEL = '9542354699';
const LADA = '1';
const CODIGO = '424242';
const PASS_NUEVA = 'NuevaPass2026!';

const post = (ruta, body) => axios.post(`${API}${ruta}`, body, { validateStatus: () => true, timeout: 15000 });

(async () => {
  const u = await Usuario.findOne({ where: { telefono: TEL, lada: LADA } });
  if (!u) throw new Error('Cuenta de prueba no encontrada — corre primero el registro.');

  await u.update({
    reset_codigo: await bcrypt.hash(CODIGO, 10),
    reset_expira: new Date(Date.now() + 15 * 60 * 1000),
    reset_intentos: 0,
  });
  const tokenVersionAntes = u.token_version;

  const malo = await post('/auth/restablecer-password', { telefono: TEL, lada: LADA, codigo: '000000', password: PASS_NUEVA });
  console.log('código incorrecto →', malo.status, malo.data.mensaje);

  const bueno = await post('/auth/restablecer-password', { telefono: TEL, lada: LADA, codigo: CODIGO, password: PASS_NUEVA });
  console.log('código correcto  →', bueno.status, bueno.data.mensaje);

  const login = await post('/auth/login', { telefono: TEL, lada: LADA, password: PASS_NUEVA });
  console.log('login con la contraseña nueva →', login.status, login.data.mensaje);

  await u.reload();
  console.log('token_version', tokenVersionAntes, '→', u.token_version, '(sesiones viejas invalidadas:', u.token_version > tokenVersionAntes, ')');
  console.log('reset_codigo limpiado:', u.reset_codigo === null);

  const reusar = await post('/auth/restablecer-password', { telefono: TEL, lada: LADA, codigo: CODIGO, password: 'OtraMas2026!' });
  console.log('reusar el mismo código →', reusar.status, reusar.data.mensaje);

  await sequelize.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
