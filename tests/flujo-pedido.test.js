/**
 * Test interno de flujo — VoyCorriendo
 * ─────────────────────────────────────────────────────────────
 * Corre contra el backend REAL desplegado (no hay entorno de staging),
 * usando las cuentas de prueba fijas (0000000001-4 / VoyTest2026!).
 *
 * Cada test que crea datos los limpia al final (afterAll / afterEach)
 * para no dejar basura permanente en la base de producción. Los pedidos
 * completos (efectivo → entregado) SÍ generan efectos económicos reales
 * (ledger, deuda del negocio) — el test los revierte explícitamente.
 *
 * Correr con: npm test
 */
const { cliente, login, conAuth } = require('./helpers/api');
const { conectar } = require('./helpers/db');

jest.setTimeout(30000);

// ─── Datos fijos de las cuentas de prueba ─────────────────────
const NEGOCIO_DON_BETO = {
  id: '33333333-0000-0000-0000-000000000001',
  lat: 15.8631, lng: -97.0676,
};
const PRODUCTO_PASTOR    = '36f7d479-f8c6-484e-9999-7e5561fc78fe'; // $22
const PRODUCTO_QUESADILLA = '32d21de7-d001-42b1-b614-128327e2f96e'; // $45

// Punto cercano a Don Beto (~1.5 km) — dentro de cobertura estándar (5 km)
const DESTINO_CERCA = { lat: 15.8650, lng: -97.0700 };
// Punto absurdamente lejos (Illinois, EUA) — el mismo tipo de error real
// que causó el bug de MND-280836
const DESTINO_LEJOS = { lat: 42.2458792, lng: -87.9472467 };

let db;
const pedidosACancelar = []; // ids creados durante los tests, se cancelan/borran al final

beforeAll(async () => {
  db = await conectar();
});

afterAll(async () => {
  // Red de seguridad: cualquier pedido de prueba que haya quedado vivo se cancela.
  for (const id of pedidosACancelar) {
    try {
      await db.query(`UPDATE pedidos SET estado = 'cancelado', cancelado_en = NOW() WHERE id = $1 AND estado NOT IN ('cancelado','entregado')`, [id]);
    } catch (_) {}
  }
  await db.end();
});

const crearPedido = async (token, overrides = {}) => {
  const body = {
    negocio_id: NEGOCIO_DON_BETO.id,
    items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 5 }, { producto_id: PRODUCTO_QUESADILLA, cantidad: 1 }], // 5*22+45=155, >= PEDIDO_MINIMO
    direccion_entrega: 'Test automatizado — ignorar',
    latitud_entrega: DESTINO_CERCA.lat,
    longitud_entrega: DESTINO_CERCA.lng,
    metodo_pago: 'efectivo',
    tipo_envio: 'standard',
    ...overrides,
  };
  return cliente.post('/pedidos', body, conAuth(token));
};

describe('Autenticación y roles', () => {
  test('las 4 cuentas de prueba inician sesión correctamente', async () => {
    for (const rol of ['admin', 'cliente', 'negocio', 'repartidor']) {
      const { usuario } = await login(rol);
      expect(usuario).toBeDefined();
      expect(usuario.estado).toBe('activo');
    }
  });
});

describe('Sistema de tokens eliminado', () => {
  test('las rutas /api/tokens/* ya no existen (404)', async () => {
    const { token } = await login('negocio');
    const res = await cliente.get('/tokens/packs', conAuth(token));
    expect(res.status).toBe(404);
  });
});

describe('Validación de cobertura de entrega (bug MND-280836)', () => {
  test('rechaza un pedido a una distancia imposible (>5km)', async () => {
    const { token } = await login('cliente');
    const res = await crearPedido(token, { latitud_entrega: DESTINO_LEJOS.lat, longitud_entrega: DESTINO_LEJOS.lng });
    expect(res.status).toBe(400);
    expect(res.data.ok).toBe(false);
    expect(res.data.mensaje).toMatch(/cobertura|km/i);
  });

  test('rechaza un pedido sin ubicación GPS del cliente (antes se aceptaba sin límite)', async () => {
    const { token } = await login('cliente');
    const res = await crearPedido(token, { latitud_entrega: undefined, longitud_entrega: undefined });
    expect(res.status).toBe(400);
    expect(res.data.mensaje).toMatch(/ubicaci[oó]n/i);
  });

  test('acepta un pedido a distancia real dentro de cobertura', async () => {
    const { token } = await login('cliente');
    const res = await crearPedido(token);
    expect(res.status).toBe(201);
    expect(res.data.ok).toBe(true);
    expect(parseFloat(res.data.data.pedido.distancia_km)).toBeLessThan(5);
    pedidosACancelar.push(res.data.data.pedido.id);
    // limpiar de inmediato, este test no necesita el pedido vivo
    await db.query(`DELETE FROM pedidos WHERE id = $1`, [res.data.data.pedido.id]);
  });
});

describe('Pedido con tarjeta no visible al negocio hasta que se pague', () => {
  let pedidoId;

  afterEach(async () => {
    if (pedidoId) {
      await db.query(`DELETE FROM pedidos WHERE id = $1`, [pedidoId]);
      pedidoId = null;
    }
  });

  test('un pedido con tarjeta sin capturar no aparece en la lista del negocio', async () => {
    const { token: tokenCliente }  = await login('cliente');
    const { token: tokenNegocio }  = await login('negocio');

    const res = await crearPedido(tokenCliente, { metodo_pago: 'tarjeta' });
    expect(res.status).toBe(201);
    pedidoId = res.data.data.pedido.id;
    expect(res.data.data.pedido.pago_estado).toBe('pendiente');

    const lista = await cliente.get('/pedidos/negocio/mis-pedidos', conAuth(tokenNegocio));
    const idsVisibles = lista.data.data.pedidos.map((p) => p.id);
    expect(idsVisibles).not.toContain(pedidoId);
  });

  test('el mismo pedido SÍ aparece una vez que pago_estado pasa a capturado', async () => {
    const { token: tokenCliente } = await login('cliente');
    const { token: tokenNegocio } = await login('negocio');

    const res = await crearPedido(tokenCliente, { metodo_pago: 'tarjeta' });
    pedidoId = res.data.data.pedido.id;

    await db.query(`UPDATE pedidos SET pago_estado = 'capturado' WHERE id = $1`, [pedidoId]);

    const lista = await cliente.get('/pedidos/negocio/mis-pedidos', conAuth(tokenNegocio));
    const idsVisibles = lista.data.data.pedidos.map((p) => p.id);
    expect(idsVisibles).toContain(pedidoId);
  });
});

describe('Permisos — un repartidor no puede tocar pedidos ajenos', () => {
  let pedidoId;

  afterAll(async () => {
    if (pedidoId) await db.query(`DELETE FROM pedidos WHERE id = $1`, [pedidoId]);
  });

  test('confirmar entrega de un pedido no asignado devuelve 403', async () => {
    const { token: tokenCliente } = await login('cliente');
    const { token: tokenRepartidor } = await login('repartidor');

    const res = await crearPedido(tokenCliente);
    pedidoId = res.data.data.pedido.id;

    const intento = await cliente.patch(
      `/pedidos/${pedidoId}/estado`,
      { estado: 'entregado', codigo_entrega: '0000' },
      conAuth(tokenRepartidor)
    );
    expect(intento.status).toBe(403);
    expect(intento.data.mensaje).toMatch(/no te pertenece/i);
  });

  test('registrar pago en efectivo de un pedido ajeno devuelve 403 (no autorizado), no un error de rol', async () => {
    // Este es el caso exacto del bug de modo_activo desincronizado que se
    // arregló hoy: el endpoint YA NO debe bloquear por rol/modo — debe
    // bloquear por ownership real, con un mensaje distinto.
    const { token: tokenRepartidor } = await login('repartidor');
    const res = await cliente.post(
      '/pagos/efectivo',
      { pedido_id: pedidoId, monto_recibido: 99999 },
      conAuth(tokenRepartidor)
    );
    expect(res.status).toBe(403);
    expect(res.data.mensaje).not.toMatch(/Rol requerido/i);
  });
});

describe('Validación de imágenes subidas (mime/tamaño)', () => {
  test('rechaza un mime type que no es imagen', async () => {
    const { token } = await login('repartidor');
    const res = await cliente.post(
      '/repartidores/foto',
      { tipo: 'licencia', base64: 'aGVsbG8=', mime: 'application/x-msdownload' },
      conAuth(token)
    );
    expect(res.status).toBe(500); // el controller no traduce el error a 400, pero SÍ debe rechazar
    expect(res.data.ok).toBe(false);
    expect(res.data.mensaje).toMatch(/no permitido/i);
  });
});

describe('Flujo completo feliz: efectivo, pendiente → entregado', () => {
  let pedidoId, pedidoNumero, repartidorRowId;

  afterAll(async () => {
    // Revertir efectos económicos del pedido de prueba y borrarlo.
    if (pedidoId) {
      await db.query(`DELETE FROM ledger_conciliacion WHERE pedido_id = $1`, [pedidoId]);
      await db.query(`UPDATE negocios SET deuda_plataforma = GREATEST(0, deuda_plataforma - 35) WHERE id = $1`, [NEGOCIO_DON_BETO.id]);
      await db.query(`DELETE FROM pedidos WHERE id = $1`, [pedidoId]);
    }
  });

  test('cliente crea el pedido', async () => {
    const { token } = await login('cliente');
    const res = await crearPedido(token);
    expect(res.status).toBe(201);
    pedidoId     = res.data.data.pedido.id;
    pedidoNumero = res.data.data.pedido.numero;
    expect(res.data.data.pedido.estado).toBe('pendiente');
  });

  test('negocio confirma → preparando → listo', async () => {
    const { token } = await login('negocio');
    for (const estado of ['confirmado', 'preparando', 'listo']) {
      const res = await cliente.patch(`/pedidos/${pedidoId}/estado`, { estado }, conAuth(token));
      expect(res.status).toBe(200);
      expect(res.data.data.pedido.estado).toBe(estado);
    }
  });

  test('repartidor acepta el pedido', async () => {
    const { token } = await login('repartidor');
    const res = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: pedidoId }, conAuth(token));
    expect(res.status).toBe(200);

    const r = await db.query(`SELECT id, repartidor_id, codigo_entrega, estado FROM pedidos WHERE id = $1`, [pedidoId]);
    expect(r.rows[0].estado).toBe('en_camino');
    expect(r.rows[0].repartidor_id).not.toBeNull();
  });

  test('repartidor registra el cobro en efectivo', async () => {
    const { token } = await login('repartidor');
    const r = await db.query(`SELECT total FROM pedidos WHERE id = $1`, [pedidoId]);
    const total = parseFloat(r.rows[0].total);
    const res = await cliente.post('/pagos/efectivo', { pedido_id: pedidoId, monto_recibido: total }, conAuth(token));
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });

  test('repartidor confirma la entrega con el código correcto', async () => {
    const { token } = await login('repartidor');
    const r = await db.query(`SELECT codigo_entrega FROM pedidos WHERE id = $1`, [pedidoId]);
    const codigo = r.rows[0].codigo_entrega;

    // Código incorrecto primero — debe rechazarse
    const malo = await cliente.patch(`/pedidos/${pedidoId}/estado`, { estado: 'entregado', codigo_entrega: '0000' }, conAuth(token));
    expect(malo.status).toBe(400);

    const bueno = await cliente.patch(`/pedidos/${pedidoId}/estado`, { estado: 'entregado', codigo_entrega: codigo }, conAuth(token));
    expect(bueno.status).toBe(200);
    expect(bueno.data.data.pedido.estado).toBe('entregado');
  });

  test('la entrega generó el registro de conciliación y la deuda del negocio', async () => {
    const ledger = await db.query(`SELECT * FROM ledger_conciliacion WHERE pedido_id = $1`, [pedidoId]);
    expect(ledger.rowCount).toBe(1);
    expect(ledger.rows[0].metodo_pago).toBe('efectivo');

    const negocio = await db.query(`SELECT deuda_plataforma FROM negocios WHERE id = $1`, [NEGOCIO_DON_BETO.id]);
    expect(parseFloat(negocio.rows[0].deuda_plataforma)).toBeGreaterThanOrEqual(35);
  });

  test('confirmar la entrega dos veces NO duplica la deuda ni el ledger (doble-tap / reintento de red)', async () => {
    const { token } = await login('repartidor');
    const r = await db.query(`SELECT codigo_entrega, deuda_plataforma FROM pedidos p JOIN negocios n ON n.id = p.negocio_id WHERE p.id = $1`, [pedidoId]);
    const { codigo_entrega: codigo } = r.rows[0];

    const deudaAntes = await db.query(`SELECT deuda_plataforma FROM negocios WHERE id = $1`, [NEGOCIO_DON_BETO.id]);

    const repetido = await cliente.patch(`/pedidos/${pedidoId}/estado`, { estado: 'entregado', codigo_entrega: codigo }, conAuth(token));
    // Se rechaza — ya sea por la máquina de estados (400, "entregado" no
    // tiene transición a "entregado") o por el candado atómico (409) si
    // llegara a pasar la primera validación. Lo que importa es que NO
    // procese la economía otra vez.
    expect([400, 409]).toContain(repetido.status);

    const deudaDespues = await db.query(`SELECT deuda_plataforma FROM negocios WHERE id = $1`, [NEGOCIO_DON_BETO.id]);
    expect(parseFloat(deudaDespues.rows[0].deuda_plataforma)).toBe(parseFloat(deudaAntes.rows[0].deuda_plataforma));

    const ledger = await db.query(`SELECT COUNT(*) FROM ledger_conciliacion WHERE pedido_id = $1`, [pedidoId]);
    expect(parseInt(ledger.rows[0].count)).toBe(1);
  });

  test('cliente puede calificar el pedido entregado', async () => {
    const { token } = await login('cliente');
    const res = await cliente.post(
      `/pedidos/${pedidoId}/calificar`,
      { calificacion_negocio: 5, calificacion_repartidor: 5, propina: 10 },
      conAuth(token)
    );
    expect(res.status).toBe(200);
  });

  test('la propina de un pedido en EFECTIVO NO se acredita al fondo retirable (ya se dio en mano)', async () => {
    const p = await db.query(`SELECT repartidor_id, propina FROM pedidos WHERE id = $1`, [pedidoId]);
    expect(parseFloat(p.rows[0].propina)).toBe(10);

    // El fondo_repartidor es dinero que la plataforma transfiere por SPEI al
    // pedir retiro. Sumar ahí una propina en efectivo (que el cliente ya le
    // dio en mano al repartidor) generaría un pago duplicado real.
    const fondo = await db.query(`SELECT monto_disponible FROM fondo_repartidor WHERE repartidor_id = $1`, [p.rows[0].repartidor_id]);
    if (fondo.rowCount > 0) {
      expect(parseFloat(fondo.rows[0].monto_disponible)).toBe(0);
    }
  });
});

describe('Rutas de ruta (batch) del repartidor', () => {
  let pedidoDonBeto, pedidoSaborAMi;
  const SABOR_A_MI = { id: '04660a1d-b26b-46ff-b03f-0b2215ab3d46' };

  afterAll(async () => {
    for (const id of [pedidoDonBeto, pedidoSaborAMi]) {
      if (id) await db.query(`DELETE FROM pedidos WHERE id = $1`, [id]);
    }
  });

  test('un repartidor no puede aceptar pedidos de dos negocios distintos en la misma ruta', async () => {
    const codigo1 = String(Math.floor(1000 + Math.random() * 9000));
    const codigo2 = String(Math.floor(1000 + Math.random() * 9000));
    const numero1 = `MND-TEST${Date.now()}`.slice(0, 12);
    const numero2 = `MND-TST2${Date.now()}`.slice(0, 12);

    // Insertamos dos pedidos directo en 'listo' (bypass del flujo de negocio,
    // solo para probar la restricción del lado del repartidor).
    const { usuario: cli } = await login('cliente');
    const r1 = await db.query(`
      INSERT INTO pedidos (numero, cliente_id, negocio_id, items, subtotal, costo_envio, total, metodo_pago, pago_estado, estado, tipo_envio, ciudad, codigo_entrega, fee_cliente, direccion_entrega)
      VALUES ($1, $2, $3, '[]'::jsonb, 200, 35, 235, 'efectivo', 'pendiente', 'listo', 'standard', 'puerto_escondido', $4, 35, 'Test automatizado — ignorar')
      RETURNING id
    `, [numero1, cli.id, NEGOCIO_DON_BETO.id, codigo1]);
    pedidoDonBeto = r1.rows[0].id;

    const r2 = await db.query(`
      INSERT INTO pedidos (numero, cliente_id, negocio_id, items, subtotal, costo_envio, total, metodo_pago, pago_estado, estado, tipo_envio, ciudad, codigo_entrega, fee_cliente, direccion_entrega)
      VALUES ($1, $2, $3, '[]'::jsonb, 200, 35, 235, 'efectivo', 'pendiente', 'listo', 'standard', 'puerto_escondido', $4, 35, 'Test automatizado — ignorar')
      RETURNING id
    `, [numero2, cli.id, SABOR_A_MI.id, codigo2]);
    pedidoSaborAMi = r2.rows[0].id;

    const { token: tokenRep } = await login('repartidor');

    const aceptar1 = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: pedidoDonBeto }, conAuth(tokenRep));
    expect(aceptar1.status).toBe(200);

    const aceptar2 = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: pedidoSaborAMi }, conAuth(tokenRep));
    expect(aceptar2.status).toBe(409);
    expect(aceptar2.data.mensaje).toMatch(/otro negocio/i);
  });
});
