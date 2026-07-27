require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.TEST_BASE_URL || 'https://voycorriendo-backend-production.up.railway.app';

// Certificados en el entorno de desarrollo de Windows a veces fallan la
// revisión de revocación local (no es un problema del servidor real).
const https = require('https');
const agenteInseguro = new https.Agent({ rejectUnauthorized: false });

const cliente = axios.create({
  baseURL: `${BASE_URL}/api`,
  httpsAgent: agenteInseguro,
  validateStatus: () => true, // dejamos que los tests decidan qué status es válido
});

const CUENTAS_TEST = {
  admin:      { telefono: '0000000001', password: 'VoyTest2026!' },
  cliente:    { telefono: '0000000002', password: 'VoyTest2026!' },
  negocio:    { telefono: '0000000003', password: 'VoyTest2026!' },
  repartidor: { telefono: '0000000004', password: 'VoyTest2026!' },
};

const _tokenCache = {};

// Las cuentas ADMIN llevan segundo factor obligatorio (el código real llega
// por Telegram/SMS/correo del dueño, que los tests no pueden leer). Para
// poder probar, se siembra un código conocido directo en la base — el mismo
// hash bcrypt que escribiría el servidor — y se canjea por la vía normal.
// El candado NO se salta: se sigue pasando por /auth/login-2fa.
const completar2FA = async (telefono, password) => {
  const bcrypt = require('bcryptjs');
  const { conectar } = require('./db');
  const db = await conectar();
  const codigo = '246813';
  try {
    await db.query(
      `UPDATE usuarios SET login2fa_codigo = $1, login2fa_expira = NOW() + INTERVAL '10 minutes', login2fa_intentos = 0
        WHERE telefono = $2`,
      [await bcrypt.hash(codigo, 10), telefono],
    );
  } finally {
    // conectar() abre un cliente nuevo cada vez; sin cerrarlo, Jest se queda
    // colgado al final esperando que el event loop se vacíe.
    await db.end().catch(() => {});
  }
  return cliente.post('/auth/login-2fa', { telefono, password, codigo });
};

const login = async (rol) => {
  if (_tokenCache[rol]) return _tokenCache[rol];
  const { telefono, password } = CUENTAS_TEST[rol];
  let res = await cliente.post('/auth/login', { telefono, password });

  if (res.data?.requiere_2fa) {
    res = await completar2FA(telefono, password);
  }
  if (!res.data?.ok || !res.data?.data?.token) {
    throw new Error(`Login falló para ${rol} (${telefono}): ${JSON.stringify(res.data)}`);
  }
  _tokenCache[rol] = {
    token: res.data.data.token,
    usuario: res.data.data.usuario,
  };
  return _tokenCache[rol];
};

const conAuth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

// Necesario cuando el ROL de una cuenta cambia a media suite (los tests del
// panel promueven temporalmente la cuenta de prueba): el token cacheado se
// emitió con el rol anterior y ya no sirve.
const limpiarCacheLogin = (rol) => {
  if (rol) delete _tokenCache[rol];
  else Object.keys(_tokenCache).forEach((k) => delete _tokenCache[k]);
};

module.exports = { cliente, login, conAuth, limpiarCacheLogin, CUENTAS_TEST, BASE_URL };
