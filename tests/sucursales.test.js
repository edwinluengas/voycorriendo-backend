/**
 * Sucursales: un mismo dueño, un negocio por plaza.
 *
 * Lo que se blinda:
 *  - Sin header `X-Negocio-Id` todo sigue apuntando a la matriz, así la app
 *    que ya está en Play (que no manda el header) no cambia de comportamiento.
 *  - Una sucursal nueva nace como borrador con el menú y los datos de marca
 *    de la matriz, y SIN dirección/GPS/foto del local/comprobante.
 *  - No se pueden tener dos sucursales del mismo dueño en la misma plaza.
 *  - El header nunca deja operar un negocio ajeno.
 *
 * Usa la cuenta de prueba de negocio (0000000003, "Tacos Don Beto", Puerto
 * Escondido) y borra la sucursal que crea.
 */
const { cliente, login, conAuth } = require('./helpers/api');
const { conectar } = require('./helpers/db');
const { CIUDADES } = require('../src/config/ciudades');

const centro = (slug) => {
  const c = CIUDADES.find((x) => x.slug === slug);
  return { latitud: Number(c.latitud), longitud: Number(c.longitud) };
};

let token, matriz, sucursalId;
const conNegocio = (id) => ({ headers: { ...conAuth(token).headers, 'X-Negocio-Id': id } });

const borrarSucursal = async (id) => {
  if (!id) return;
  const db = await conectar();
  try {
    await db.query('DELETE FROM productos WHERE negocio_id = $1', [id]);
    await db.query('DELETE FROM negocios WHERE id = $1 AND matriz_id IS NOT NULL', [id]);
  } finally {
    await db.end().catch(() => {});
  }
};

beforeAll(async () => {
  ({ token } = await login('negocio'));
  const r = await cliente.get('/negocios/mi-negocio', conAuth(token));
  matriz = r.data.data.negocio;
  // Restos de una corrida cortada: se limpian antes de empezar.
  const l = await cliente.get('/negocios/mis-sucursales', conAuth(token));
  for (const s of (l.data?.data?.sucursales || []).filter((x) => !x.es_matriz)) {
    await borrarSucursal(s.id);
  }
});

afterAll(async () => { await borrarSucursal(sucursalId); });

describe('Sucursales', () => {
  test('al inicio el dueño solo tiene su matriz', async () => {
    const r = await cliente.get('/negocios/mis-sucursales', conAuth(token));
    expect(r.status).toBe(200);
    const s = r.data.data.sucursales;
    expect(s).toHaveLength(1);
    expect(s[0].id).toBe(matriz.id);
    expect(s[0].es_matriz).toBe(true);
    expect(s[0].plaza_nombre).toBe('Puerto Escondido');
  });

  test('crear sucursal: borrador con marca y menú de la matriz, sin datos del local', async () => {
    const r = await cliente.post('/negocios/mis-sucursales', {}, conAuth(token));
    expect(r.status).toBe(201);
    const s = r.data.data.sucursal;
    sucursalId = s.id;
    expect(s.matriz_id).toBe(matriz.id);
    expect(s.nombre).toBe(matriz.nombre);
    expect(s.verificacion_estado).toBe('pendiente');
    expect(s.activo).toBe(false);
    expect(s.direccion).toBeNull();
    expect(s.latitud).toBeNull();
    expect(s.foto_local).toBeNull();
    expect(s.comprobante_domicilio).toBeNull();

    const menuMatriz = await cliente.get('/negocios/mi-negocio/productos', conAuth(token));
    const menuSucursal = await cliente.get('/negocios/mi-negocio/productos', conNegocio(sucursalId));
    expect(menuSucursal.status).toBe(200);
    expect(menuSucursal.data.data.productos.length).toBe(menuMatriz.data.data.productos.length);
    expect(menuSucursal.data.data.productos.every((p) => p.negocio_id === sucursalId)).toBe(true);
  });

  test('pedir otra sucursal con un borrador abierto devuelve el mismo borrador', async () => {
    const r = await cliente.post('/negocios/mis-sucursales', {}, conAuth(token));
    expect(r.status).toBe(200);
    expect(r.data.data.sucursal.id).toBe(sucursalId);
  });

  test('sin header se sigue operando la matriz (app vieja)', async () => {
    const r = await cliente.get('/negocios/mi-negocio', conAuth(token));
    expect(r.data.data.negocio.id).toBe(matriz.id);
  });

  test('con header se opera la sucursal', async () => {
    const r = await cliente.get('/negocios/mi-negocio', conNegocio(sucursalId));
    expect(r.data.data.negocio.id).toBe(sucursalId);
  });

  test('un header con un negocio ajeno NO lo deja operar: cae en su matriz', async () => {
    // Antojitos La Mixteca (Zacatepec) es de otra cuenta.
    const otro = await cliente.get('/negocios', { params: { ciudad: 'zacatepec' } });
    const ajeno = otro.data.data.negocios[0];
    expect(ajeno).toBeTruthy();
    const r = await cliente.get('/negocios/mi-negocio', conNegocio(ajeno.id));
    expect(r.data.data.negocio.id).toBe(matriz.id);
  });

  test('NO se puede ubicar la sucursal en la plaza de la matriz', async () => {
    const r = await cliente.patch('/negocios/mi-negocio', centro('puerto_escondido'), conNegocio(sucursalId));
    expect(r.status).toBe(400);
    expect(r.data.mensaje).toMatch(/Ya tienes una sucursal en Puerto Escondido/);
  });

  test('ubicada en Putla queda en la plaza de Putla, y la matriz no se mueve', async () => {
    const r = await cliente.patch('/negocios/mi-negocio', centro('putla'), conNegocio(sucursalId));
    expect(r.status).toBe(200);
    expect(r.data.data.negocio.ciudad).toBe('putla');

    const m = await cliente.get('/negocios/mi-negocio', conAuth(token));
    expect(m.data.data.negocio.ciudad).toBe('puerto_escondido');

    const l = await cliente.get('/negocios/mis-sucursales', conAuth(token));
    const s = l.data.data.sucursales.find((x) => x.id === sucursalId);
    expect(s.plaza_nombre).toBe('Putla Villa de Guerrero');
  });

  test('la sucursal sin aprobar NO aparece en el catálogo de Putla', async () => {
    const r = await cliente.get('/negocios', { params: { ciudad: 'putla' } });
    expect(r.data.data.negocios.some((n) => n.id === sucursalId)).toBe(false);
  });

  test('la sucursal sin aprobar no puede abrir', async () => {
    const r = await cliente.patch('/negocios/apertura', { abierto: true }, conNegocio(sucursalId));
    expect(r.status).toBe(403);
  });
});
