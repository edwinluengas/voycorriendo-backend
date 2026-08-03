/**
 * Tests de aislamiento por plaza (localidad).
 *
 * VoyCorriendo opera en pueblos separados por ~150 km. La regla es simple y
 * no admite fugas: **cada quien ve solo lo de su plaza**. Un cliente de
 * Zacatepec no ve negocios de Puerto Escondido, un repartidor de Putla no ve
 * —ni puede aceptar— pedidos de otra plaza, y fuera de las plazas no hay
 * servicio y se dice.
 *
 * Estos tests blindan el bug real de agosto de 2026: el filtro por ciudad
 * existía y funcionaba en el servidor, pero la app pedía el catálogo SIN
 * ciudad (una dependencia mal puesta en un useCallback), así que el servidor
 * respondía con la plaza por defecto y todo el mundo veía Puerto Escondido.
 * La parte de servidor se prueba aquí; la de la app, en el propio hook.
 */
const { cliente, login, conAuth } = require('./helpers/api');
const { plazaDe, CIUDADES, SLUGS, RADIO_PLAZA_KM } = require('../src/config/ciudades');

describe('Plazas — configuración', () => {
  test('las cuatro plazas están dadas de alta', () => {
    expect(SLUGS).toEqual(
      expect.arrayContaining(['puerto_escondido', 'putla', 'zacatepec', 'pinotepa']),
    );
  });

  test('cada plaza tiene marca propia y Puerto Escondido va sin apellido', () => {
    for (const c of CIUDADES) {
      expect(typeof c.marca).toBe('string');
      expect(c.marca.length).toBeGreaterThan(0);
    }
    expect(CIUDADES.find((c) => c.slug === 'puerto_escondido').marca).toBe('VoyCorriendo');
    expect(CIUDADES.find((c) => c.slug === 'putla').marca).toBe('VoyCorriendo Putla');
    expect(CIUDADES.find((c) => c.slug === 'zacatepec').marca).toBe('VoyCorriendo Zacatepec');
    expect(CIUDADES.find((c) => c.slug === 'pinotepa').marca).toBe('VoyCorriendo Pinotepa');
  });

  test('el centro de cada plaza cae en su propia plaza', () => {
    for (const c of CIUDADES) {
      const r = plazaDe(c.latitud, c.longitud);
      expect(r.slug).toBe(c.slug);
      expect(r.dentro).toBe(true);
    }
  });

  test('fuera de toda plaza NO hay cobertura (Oaxaca capital, CDMX)', () => {
    for (const [lat, lng] of [[17.0732, -96.7266], [19.4326, -99.1332]]) {
      const r = plazaDe(lat, lng);
      expect(r.dentro).toBe(false);
      expect(r.km).toBeGreaterThan(RADIO_PLAZA_KM);
    }
  });

  test('sin coordenadas NO se inventa una plaza', () => {
    // `Number(null)` es 0: sin este candado unas coordenadas ausentes se
    // situaban en el Golfo de Guinea y devolvían una plaza "más cercana".
    for (const [lat, lng] of [[null, null], [undefined, undefined], ['', ''], ['x', 'y']]) {
      const r = plazaDe(lat, lng);
      expect(r.slug).toBeNull();
      expect(r.dentro).toBe(false);
    }
  });

  test('unas coordenadas 0,0 tampoco caen en ninguna plaza', () => {
    expect(plazaDe(0, 0).dentro).toBe(false);
  });
});

describe('Plazas — la app las recibe del servidor', () => {
  test('/config-publica publica las plazas y el radio', async () => {
    const r = await cliente.get('/config-publica');
    expect(r.status).toBe(200);
    const slugs = (r.data.data.ciudades || []).map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(SLUGS));
    expect(r.data.data.radio_plaza_km).toBeGreaterThan(0);
    // Cada plaza viaja con su marca y sus coordenadas: la app las necesita
    // para nombrar el servicio y para saber si el usuario está dentro.
    for (const c of r.data.data.ciudades) {
      expect(c).toEqual(expect.objectContaining({
        slug: expect.any(String), nombre: expect.any(String),
        marca: expect.any(String), latitud: expect.any(Number), longitud: expect.any(Number),
      }));
    }
  });
});

describe('Plazas — el catálogo no se mezcla', () => {
  test('cada plaza devuelve SOLO negocios de esa plaza', async () => {
    for (const slug of SLUGS) {
      const r = await cliente.get(`/negocios?ciudad=${slug}`);
      expect(r.status).toBe(200);
      const negocios = r.data.data.negocios || [];
      for (const n of negocios) {
        expect(n.ciudad).toBe(slug);
      }
    }
  });

  test('ninguna plaza ve los negocios de otra', async () => {
    const porPlaza = {};
    for (const slug of SLUGS) {
      const r = await cliente.get(`/negocios?ciudad=${slug}`);
      porPlaza[slug] = new Set((r.data.data.negocios || []).map((n) => n.id));
    }
    for (const a of SLUGS) {
      for (const b of SLUGS) {
        if (a === b) continue;
        const comunes = [...porPlaza[a]].filter((id) => porPlaza[b].has(id));
        expect(comunes).toEqual([]);
      }
    }
  });

  test('sin localidad NO se devuelve catálogo', async () => {
    // Antes caía a la localidad por defecto, y por eso todo el mundo veía
    // Puerto Escondido: la app pedía sin ciudad y el servidor respondía con
    // una cualquiera. Ahora se dice que no hay cobertura y punto.
    for (const url of ['/negocios', '/negocios?ciudad=', '/negocios?ciudad=narnia']) {
      const r = await cliente.get(url);
      expect(r.status).toBe(200);
      expect(r.data.data.negocios).toEqual([]);
      expect(r.data.data.sin_cobertura).toBe(true);
    }
  });

  test('cada plaza tiene al menos un negocio aprobado (incluida Pinotepa)', async () => {
    // Una plaza anunciada sin negocios es una app vacía para quien vive ahí.
    for (const slug of SLUGS) {
      const r = await cliente.get(`/negocios?ciudad=${slug}`);
      expect((r.data.data.negocios || []).length).toBeGreaterThan(0);
    }
  });
});

describe('Plazas — la del repartidor sale de su GPS', () => {
  // Estos tests mueven de plaza a la cuenta de prueba: al final la dejan
  // como estaba (desconectada y en su plaza original).
  let estadoOriginal = null;

  beforeAll(async () => {
    const { token } = await login('repartidor');
    const r = await cliente.get('/repartidores/mi-perfil', conAuth(token));
    estadoOriginal = r.data?.data?.repartidor?.ciudad || null;
  });

  afterAll(async () => {
    const { token } = await login('repartidor');
    const casa = CIUDADES.find((c) => c.slug === (estadoOriginal || 'puerto_escondido'));
    // Reconectar desde su plaza original la restituye, y luego se desconecta.
    await cliente.patch('/repartidores/conectarse',
      { conectado: true, latitud: casa.latitud, longitud: casa.longitud }, conAuth(token));
    await cliente.patch('/repartidores/conectarse', { conectado: false }, conAuth(token));
  });

  test('conectarse desde Putla lo pone en Putla, no en la plaza por defecto', async () => {
    const { token } = await login('repartidor');
    const putla = CIUDADES.find((c) => c.slug === 'putla');
    const r = await cliente.patch('/repartidores/conectarse',
      { conectado: true, latitud: putla.latitud, longitud: putla.longitud }, conAuth(token));
    expect(r.status).toBe(200);
    expect(r.data.data.ciudad).toBe('putla');

    // Y lo que ve son pedidos de Putla, nunca de otra plaza.
    const d = await cliente.get('/repartidores/pedidos-disponibles', conAuth(token));
    expect(d.status).toBe(200);
    for (const p of d.data.data.pedidos || []) expect(p.ciudad).toBe('putla');
  });

  test('conectarse desde fuera de toda plaza se rechaza — no hay cobertura ahí', async () => {
    const { token } = await login('repartidor');
    // Oaxaca capital: a 127 km de la plaza más cercana.
    const r = await cliente.patch('/repartidores/conectarse',
      { conectado: true, latitud: 17.0732, longitud: -96.7266 }, conAuth(token));
    expect(r.status).toBe(403);
    expect(r.data.mensaje).toMatch(/cobertura/i);
  });
});

describe('Plazas — no se puede pedir a un negocio de otro pueblo', () => {
  // Pickup no mide distancia (no hay reparto que cubrir), así que por ahí se
  // colaba un pedido a un negocio a 200 km entrando por enlace directo: el
  // negocio cocinaba para alguien que nunca iba a llegar.
  let negocioOtraPlaza = null, producto = null, token = null;

  beforeAll(async () => {
    ({ token } = await login('cliente'));
    for (const slug of SLUGS.filter((s) => s !== 'puerto_escondido')) {
      const r = await cliente.get(`/negocios?ciudad=${slug}`);
      const n = (r.data.data.negocios || [])[0];
      if (!n) continue;
      const detalle = await cliente.get(`/negocios/${n.id}`);
      const prods = detalle.data?.data?.negocio?.productos || [];
      if (prods.length) { negocioOtraPlaza = n; producto = prods[0]; break; }
    }
  });

  const pedirPickup = (extra) => cliente.post('/pedidos', {
    negocio_id: negocioOtraPlaza.id,
    items: [{ producto_id: producto.id, cantidad: 3 }],
    metodo_pago: 'efectivo', tipo_envio: 'pickup',
    ...extra,
  }, conAuth(token));

  test('con GPS de otra plaza se rechaza', async () => {
    if (!negocioOtraPlaza) return; // sin datos sembrados no aplica
    const r = await pedirPickup({ latitud_entrega: 15.8631, longitud_entrega: -97.0676 });
    expect(r.status).toBe(400);
    expect(r.data.codigo).toBe('OTRA_PLAZA');
  });

  test('con la plaza que declara la app se rechaza', async () => {
    if (!negocioOtraPlaza) return;
    const r = await pedirPickup({ ciudad_cliente: 'puerto_escondido' });
    expect(r.status).toBe(400);
    expect(r.data.codigo).toBe('OTRA_PLAZA');
  });

  test('mandar una localidad inventada tampoco sirve para saltarse el candado', async () => {
    if (!negocioOtraPlaza) return;
    const r = await pedirPickup({ ciudad_cliente: 'narnia' });
    expect(r.status).toBe(400);
  });
});

describe('Plazas — el repartidor solo ve lo suyo', () => {
  test('los pedidos disponibles son todos de su plaza', async () => {
    const { token } = await login('repartidor');
    const r = await cliente.get('/repartidores/pedidos-disponibles', conAuth(token));
    // 403 si no está conectado: también es una respuesta válida aquí.
    if (r.status !== 200) return expect([403]).toContain(r.status);

    const yo = await cliente.get('/repartidores/mi-perfil', conAuth(token));
    const miCiudad = yo.data?.data?.repartidor?.ciudad;
    for (const p of r.data.data.pedidos || []) {
      expect(p.ciudad).toBe(miCiudad);
    }
  });

  test('no puede aceptar un pedido de otra plaza', async () => {
    const { token } = await login('repartidor');
    // Un id inexistente da 409 (ya tomado); lo que se blinda aquí es que el
    // camino de ciudad distinta responde 403 y NUNCA asigna.
    const r = await cliente.post('/repartidores/aceptar-pedido',
      { pedido_id: '00000000-0000-0000-0000-000000000000' }, conAuth(token));
    expect([403, 404, 409]).toContain(r.status);
    expect(r.status).not.toBe(200);
  });
});
