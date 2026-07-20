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

const login = async (rol) => {
  if (_tokenCache[rol]) return _tokenCache[rol];
  const { telefono, password } = CUENTAS_TEST[rol];
  const res = await cliente.post('/auth/login', { telefono, password });
  if (!res.data?.ok) {
    throw new Error(`Login falló para ${rol} (${telefono}): ${JSON.stringify(res.data)}`);
  }
  _tokenCache[rol] = {
    token: res.data.data.token,
    usuario: res.data.data.usuario,
  };
  return _tokenCache[rol];
};

const conAuth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

module.exports = { cliente, login, conAuth, CUENTAS_TEST, BASE_URL };
