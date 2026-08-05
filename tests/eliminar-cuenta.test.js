/**
 * Eliminación de cuenta y localidad anclada.
 *
 * Los dos requisitos que faltaban para poder publicar en Google Play:
 *   · el borrado de cuenta (obligatorio desde 2024 para toda app con
 *     registro, y derecho de Cancelación de la LFPDPPP);
 *   · una cuenta que vea el catálogo sin depender del GPS, porque quien
 *     revisa la app no está en Oaxaca y con la detección normal vería
 *     "sin cobertura" y concluiría que la app no funciona.
 *
 * La prueba usa cuentas DESECHABLES que crea y borra ella misma: eliminar
 * una cuenta es irreversible y no se puede ensayar con las de siempre.
 */
const { cliente, login, conAuth } = require('./helpers/api');
const { conectar } = require('./helpers/db');

jest.setTimeout(30000);

const PASS = 'PruebaBorrado1!';
const NEGOCIO_DON_BETO = '33333333-0000-0000-0000-000000000001';
const PRODUCTO_PASTOR  = '36f7d479-f8c6-484e-9999-7e5561fc78fe';

let db;
const desechables = [];   // teléfonos creados, se borran al final

beforeAll(async () => { db = await conectar(); });

afterAll(async () => {
  for (const tel of desechables) {
    try { await db.query('DELETE FROM usuarios WHERE telefono = $1', [tel]); } catch (_) {}
  }
  // Las cuentas eliminadas quedan con el teléfono sustituido por ELIM…;
  // las de esta suite se van también.
  try {
    await db.query(`DELETE FROM usuarios WHERE telefono LIKE 'ELIM%' AND email IS NULL AND nombre = 'Usuario'`);
  } catch (_) {}
  await db.end();
});

const crearDesechable = async () => {
  const tel = String(Date.now() + Math.floor(Math.random() * 999)).slice(-10);
  desechables.push(tel);
  const r = await cliente.post('/auth/registro', {
    nombre: 'Prueba', apellido: 'Borrado', telefono: tel,
    email: `borrado_${tel}@ejemplo.mx`, password: PASS, acepto_terminos: true,
  });
  expect(r.status).toBe(201);
  return { tel, token: r.data.data.token, id: r.data.data.usuario.id };
};

describe('Eliminación de cuenta — antes de confirmar', () => {
  test('dice qué se borra, qué se conserva y si se puede', async () => {
    const { token } = await crearDesechable();
    const r = await cliente.get('/usuarios/mi-cuenta/eliminacion', conAuth(token));
    expect(r.status).toBe(200);
    expect(r.data.data.puede).toBe(true);
    expect(r.data.data.se_borra.length).toBeGreaterThan(0);
    // Que se conserve el registro contable hay que DECIRLO antes, no
    // después: es lo único que no desaparece.
    expect(r.data.data.se_conserva.length).toBeGreaterThan(0);
  });
});

describe('Eliminación de cuenta — candados', () => {
  test('exige la contraseña y una sesión válida', async () => {
    const { token } = await crearDesechable();
    const sinPass = await cliente.delete('/usuarios/mi-cuenta', { ...conAuth(token), data: {} });
    expect(sinPass.status).toBe(401);
    const malPass = await cliente.delete('/usuarios/mi-cuenta', { ...conAuth(token), data: { password: 'incorrecta' } });
    expect(malPass.status).toBe(401);
    const sinToken = await cliente.delete('/usuarios/mi-cuenta', { data: { password: PASS } });
    expect(sinToken.status).toBe(401);
  });

  test('no se puede con un pedido en curso, y la cuenta queda intacta', async () => {
    const { token } = await login('cliente');
    await db.query(`DELETE FROM pedidos WHERE cliente_id = (SELECT id FROM usuarios WHERE telefono = '0000000002')`);
    const pedido = await cliente.post('/pedidos', {
      negocio_id: NEGOCIO_DON_BETO,
      items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 8 }],
      metodo_pago: 'efectivo', tipo_envio: 'pickup', ciudad_cliente: 'puerto_escondido',
    }, conAuth(token));
    expect(pedido.status).toBe(201);

    try {
      const aviso = await cliente.get('/usuarios/mi-cuenta/eliminacion', conAuth(token));
      expect(aviso.data.data.puede).toBe(false);
      expect(aviso.data.data.impedimentos.join(' ')).toMatch(/pedido/i);

      const r = await cliente.delete('/usuarios/mi-cuenta', { ...conAuth(token), data: { password: 'VoyTest2026!' } });
      expect(r.status).toBe(409);
      expect(r.data.codigo).toBe('CUENTA_CON_PENDIENTES');

      const { rows } = await db.query(`SELECT nombre, estado FROM usuarios WHERE telefono = '0000000002'`);
      expect(rows[0].nombre).toBe('Cliente');
      expect(rows[0].estado).toBe('activo');
    } finally {
      await db.query(`DELETE FROM pedidos WHERE cliente_id = (SELECT id FROM usuarios WHERE telefono = '0000000002')`);
    }
  });

  test('una cuenta de administración no se puede borrar desde la app', async () => {
    const { token } = await login('cliente');
    await db.query(`UPDATE usuarios SET rol = 'admin' WHERE telefono = '0000000002'`);
    try {
      const r = await cliente.delete('/usuarios/mi-cuenta', { ...conAuth(token), data: { password: 'VoyTest2026!' } });
      expect(r.status).toBe(403);
    } finally {
      await db.query(`UPDATE usuarios SET rol = 'cliente' WHERE telefono = '0000000002'`);
    }
  });
});

describe('Eliminación de cuenta — qué queda después', () => {
  test('no sobrevive ningún dato personal y la cuenta muere', async () => {
    const { tel, token, id } = await crearDesechable();
    const r = await cliente.delete('/usuarios/mi-cuenta', { ...conAuth(token), data: { password: PASS } });
    expect(r.status).toBe(200);

    const { rows } = await db.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    const u = rows[0];
    // La fila se queda (los pedidos históricos apuntan a ella) pero vacía.
    expect(u).toBeDefined();
    expect(u.nombre).toBe('Usuario');
    expect(u.apellido).toBe('eliminado');
    expect(u.telefono).not.toContain(tel);
    expect(u.email).toBeNull();
    expect(u.password).toBeNull();
    expect(u.foto_perfil).toBeNull();
    expect(u.estado).toBe('eliminado');

    // El token anterior deja de valer y no se puede volver a entrar.
    const conViejo = await cliente.get('/pedidos', conAuth(token));
    expect(conViejo.status).toBe(401);
    const relogin = await cliente.post('/auth/login', { telefono: tel, password: PASS });
    expect(relogin.data?.data?.token).toBeUndefined();
  });

  test('el teléfono queda libre para registrarse de nuevo', async () => {
    const { tel, token } = await crearDesechable();
    await cliente.delete('/usuarios/mi-cuenta', { ...conAuth(token), data: { password: PASS } });
    const otra = await cliente.post('/auth/registro', {
      nombre: 'Otra', apellido: 'Persona', telefono: tel,
      email: `otra_${tel}@ejemplo.mx`, password: PASS, acepto_terminos: true,
    });
    expect(otra.status).toBe(201);
  });
});

describe('Página pública de eliminación (la exige Google Play)', () => {
  test('responde sin token y explica el procedimiento completo', async () => {
    // Fuera de /api: la abre una persona en su navegador.
    const base = require('./helpers/api').BASE_URL;
    const axios = require('axios');
    const https = require('https');
    const r = await axios.get(`${base}/eliminar-cuenta`, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
    });
    expect(r.status).toBe(200);
    expect(r.data).toMatch(/Eliminar tu cuenta/i);
    expect(r.data).toMatch(/voycorriendoadmin@gmail\.com/);
    expect(r.data).toMatch(/d[ií]as h[áa]biles/);
    expect(r.data).toMatch(/se conserva/i);
    // Un marcador sin resolver en una página legal es peor que no tenerla.
    expect(r.data).not.toMatch(/undefined|\[PENDIENTE/);
  });
});

describe('Localidad anclada — cuenta de revisión de la tienda', () => {
  afterAll(async () => {
    await db.query(`UPDATE usuarios SET ciudad_fija = NULL WHERE telefono = '0000000002'`);
  });

  test('el perfil la expone para que la app la use', async () => {
    const { token } = await login('cliente');
    await db.query(`UPDATE usuarios SET ciudad_fija = 'puerto_escondido' WHERE telefono = '0000000002'`);
    const r = await cliente.get('/auth/perfil', conAuth(token));
    expect(r.status).toBe(200);
    expect(r.data.data.usuario.ciudad_fija).toBe('puerto_escondido');
  });

  test('el perfil NO filtra campos sensibles (lista blanca)', async () => {
    // Antes se filtraba con lista NEGRA: cada columna nueva quedaba
    // expuesta por omisión. Ése fue el descuido que en julio publicó la
    // INE del dueño en un endpoint sin token.
    const { token } = await login('cliente');
    const r = await cliente.get('/auth/perfil', conAuth(token));
    const u = r.data.data.usuario;
    for (const campo of [
      'password', 'otp_codigo', 'reset_codigo', 'login2fa_codigo',
      'token_version', 'ultimo_login_ip', 'intentos_fallidos', 'bloqueado_hasta',
      'admin_2fa_activo', 'token_push', 'telegram_chat_id', 'mp_customer_id',
    ]) {
      expect(u).not.toHaveProperty(campo);
    }
    // Y lo que la app sí necesita sigue llegando.
    for (const campo of ['id', 'nombre', 'telefono', 'rol', 'modo_activo', 'credito_disponible']) {
      expect(u).toHaveProperty(campo);
    }
  });
});
