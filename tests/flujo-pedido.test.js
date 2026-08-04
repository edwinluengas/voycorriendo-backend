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
const { cliente, login, conAuth, limpiarCacheLogin } = require('./helpers/api');
const { conectar } = require('./helpers/db');
// La plaza sale de la config real: si cambia, el test no se queda con un
// slug viejo que hace que el repartidor no pueda aceptar (403 por otra ciudad).
const { CIUDAD_DEFAULT: CIUDAD } = require('../src/config/ciudades');

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
  // La cobertura a domicilio exige un repartidor conectado Y con señal de
  // vida reciente (ver services/disponibilidad.service.js). Sin esto la
  // suite depende de cómo haya quedado la base de la corrida anterior: si el
  // repartidor de prueba quedó desconectado, TODOS los pedidos a domicilio
  // se rechazan con SOLO_PICKUP y fallan tests que no tienen nada roto.
  await db.query(`
    UPDATE repartidores SET conectado = true, ultimo_latido = NOW()
     WHERE usuario_id = (SELECT id FROM usuarios WHERE telefono = '0000000004')`);
});

afterAll(async () => {
  // Se deja al repartidor de prueba desconectado: que la suite no altere el
  // estado real de la operación más allá de su propia corrida.
  try {
    await db.query(`
      UPDATE repartidores SET conectado = false, ultimo_latido = NULL
       WHERE usuario_id = (SELECT id FROM usuarios WHERE telefono = '0000000004')`);
  } catch (_) {}
  // Red de seguridad: cualquier pedido de prueba que haya quedado vivo se cancela.
  for (const id of pedidosACancelar) {
    try {
      await db.query(`UPDATE pedidos SET estado = 'cancelado', cancelado_en = NOW() WHERE id = $1 AND estado NOT IN ('cancelado','entregado')`, [id]);
    } catch (_) {}
  }

  // Rastro que la suite dejaba en CADA corrida y nadie limpiaba:
  //  · `total_pedidos` del negocio de prueba subía +1 por corrida y ese
  //    número se muestra en el catálogo público, así que el negocio
  //    presumía pedidos que ya no existen (mismo patrón que el contador de
  //    deuda que se acumuló en julio hasta casi bloquear la cuenta);
  //  · las rutas (`delivery_batches`) del repartidor quedaban abiertas y
  //    huérfanas — con pedidos borrados dentro, siguen contando para el
  //    límite de 3 por ruta.
  try {
    await db.query(`
      UPDATE negocios SET total_pedidos = GREATEST(total_pedidos - $1, 0)
       WHERE id = $2`, [pedidosACancelar.length, NEGOCIO_DON_BETO.id]);
    await db.query(`
      DELETE FROM delivery_batches
       WHERE driver_id = (SELECT r.id FROM repartidores r
                            JOIN usuarios u ON u.id = r.usuario_id
                           WHERE u.telefono = '0000000004')
         AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.batch_id = delivery_batches.id)`);
  } catch (_) {}

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

describe('Seguridad de registro', () => {
  // Vulnerabilidad REAL encontrada el 2026-07-26: el rol venía del body sin
  // validar, así que cualquiera podía registrarse con {"rol":"admin"} desde
  // la app pública y quedaba con acceso total al panel de administración
  // (verificado leyendo /api/admin/creditos/resumen con esa cuenta).
  test('NO se puede crear una cuenta admin desde el registro público', async () => {
    const res = await cliente.post('/auth/registro', {
      nombre: 'Intento', apellido: 'Escalada',
      telefono: `55${Date.now()}`.slice(0, 10),
      password: 'Password123!',
      rol: 'admin',
      acepto_terminos: true,
    });
    expect(res.status).toBe(400);
    expect(res.data.ok).toBe(false);
    // Si algún día vuelve a pasar, la cuenta NO debe existir
    const { rows } = await db.query(`SELECT COUNT(*)::int AS c FROM usuarios WHERE nombre = 'Intento' AND apellido = 'Escalada'`);
    expect(rows[0].c).toBe(0);
  });
});

describe('Candados del panel de administración', () => {
  // Los administradores REALES son solo los teléfonos del dueño. La cuenta de
  // prueba ya no tiene el privilegio de forma permanente: se promueve durante
  // estos tests y se degrada al terminar, así la suite sigue verificando los
  // candados sin dejar una puerta abierta el resto del tiempo.
  const TEL_PRUEBA = '0000000001';

  beforeAll(async () => {
    await db.query(`UPDATE usuarios SET rol = 'admin', modo_activo = 'admin' WHERE telefono = $1`, [TEL_PRUEBA]);
    limpiarCacheLogin('admin');   // el token cacheado es de cuando era cliente
  });

  afterAll(async () => {
    await db.query(
      `UPDATE usuarios SET rol = 'cliente', modo_activo = 'cliente', token_version = token_version + 1
        WHERE telefono = $1`, [TEL_PRUEBA]);
    limpiarCacheLogin('admin');
  });

  test('la contraseña sola NO abre una sesión de admin (exige segundo factor)', async () => {
    const res = await cliente.post('/auth/login', {
      telefono: TEL_PRUEBA, password: 'VoyTest2026!',
    });
    expect(res.data.requiere_2fa).toBe(true);
    expect(res.data?.data?.token).toBeUndefined();   // no entrega token en el paso 1
  });

  test('un token SIN segundo factor no entra a /api/admin', async () => {
    const jwt = require('jsonwebtoken');
    const { rows } = await db.query(`SELECT id, token_version FROM usuarios WHERE telefono = $1`, [TEL_PRUEBA]);
    // Token bien firmado y vigente, pero sin la marca `dosFactores` — así se
    // veían todos los tokens antes de este candado.
    const tokenViejo = jwt.sign(
      { id: rows[0].id, tokenVersion: rows[0].token_version || 0 },
      process.env.JWT_SECRET, { expiresIn: '1h' },
    );
    const res = await cliente.get('/admin/creditos/resumen', conAuth(tokenViejo));
    // Lo que importa es que NO entre. Corriendo contra producción el token
    // ni siquiera se puede verificar (su JWT_SECRET es distinto del local) y
    // la respuesta es 401; contra un servidor con la misma clave, el candado
    // que actúa es el del segundo factor y responde 403 REQUIERE_2FA. Ambas
    // son correctas — exigir solo una hacía fallar la suite según dónde
    // corriera, no según si el sistema estaba bien.
    expect([401, 403]).toContain(res.status);
    if (res.status === 403) expect(res.data.codigo).toBe('REQUIERE_2FA');
  });

  test('una cuenta que NO es admin no entra a /api/admin', async () => {
    const { token } = await login('cliente');
    const res = await cliente.get('/admin/creditos/resumen', conAuth(token));
    expect(res.status).toBe(403);
  });

  test('el token de admin con 2FA sí abre el panel', async () => {
    const { token } = await login('admin');
    const res = await cliente.get('/admin/creditos/resumen', conAuth(token));
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });
});

describe('Sistema de tokens eliminado', () => {
  test('las rutas /api/tokens/* ya no existen (404)', async () => {
    const { token } = await login('negocio');
    const res = await cliente.get('/tokens/packs', conAuth(token));
    expect(res.status).toBe(404);
  });
});

describe('El catálogo público NO filtra datos personales del dueño', () => {
  // Regresión de una fuga real (2026-07-31): el feed usaba lista NEGRA de
  // columnas, así que cada columna nueva salía pública por omisión. Estaba
  // entregando —sin token— la INE del dueño, su RFC, su comprobante de
  // domicilio, su teléfono, su banco y su deuda con la plataforma.
  const PROHIBIDOS = [
    'documento_ine_dueno', 'documento_rfc', 'comprobante_domicilio',
    'telefono', 'banco', 'clabe_bancaria', 'deuda_plataforma',
    'pedidos_efectivo_pendientes', 'verificacion_nota', 'estado_motivo',
    'usuario_id', 'comision_porcentaje',
  ];

  // Se pide con localidad: sin ella el catálogo va vacío a propósito (no se
  // muestra nada a quien no sabemos dónde está), y este test necesita
  // negocios reales que inspeccionar.
  test('GET /negocios (sin token) no devuelve documentos ni datos financieros', async () => {
    const res = await cliente.get('/negocios?ciudad=puerto_escondido');
    expect(res.status).toBe(200);
    const negocios = res.data?.data?.negocios || [];
    expect(negocios.length).toBeGreaterThan(0);
    for (const n of negocios) {
      const filtrados = PROHIBIDOS.filter((c) => c in n);
      expect(filtrados).toEqual([]);
    }
    // Y lo que sí necesita la app tiene que seguir llegando.
    expect(negocios[0]).toHaveProperty('nombre');
    expect(negocios[0]).toHaveProperty('foto_portada');
  });

  test('GET /negocios/:id (sin token) tampoco los devuelve', async () => {
    const lista = await cliente.get('/negocios?ciudad=puerto_escondido');
    const id = lista.data.data.negocios[0].id;
    const res = await cliente.get(`/negocios/${id}`);
    expect(res.status).toBe(200);
    const n = res.data?.data?.negocio || {};
    expect(PROHIBIDOS.filter((c) => c in n)).toEqual([]);
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

  // El pedido con tarjeta se inserta DIRECTO en la base, no por la API: el
  // pago con tarjeta está desactivado durante la fase de prueba real (solo
  // efectivo), pero la regla que se prueba aquí —el negocio no debe ver un
  // pedido digital sin cobrar— sigue vigente y hay que seguir cuidándola
  // para cuando se reactive.
  const insertarPedidoTarjeta = async (pagoEstado) => {
    const { usuario: cli } = await login('cliente');
    const numero = `MND-TJ${Date.now()}`.slice(0, 12);
    const { rows } = await db.query(`
      INSERT INTO pedidos (numero, cliente_id, negocio_id, items, subtotal, costo_envio, total, metodo_pago,
                           pago_estado, estado, tipo_envio, ciudad, codigo_entrega, fee_cliente,
                           direccion_entrega, latitud_entrega, longitud_entrega)
      VALUES ($1, $2, $3, '[]'::jsonb, 200, 40, 240, 'tarjeta', $4, 'pendiente', 'standard',
              '${CIUDAD}', '1234', 40, 'Test automatizado — ignorar', $5, $6)
      RETURNING id, pago_estado
    `, [numero, cli.id, NEGOCIO_DON_BETO.id, pagoEstado, DESTINO_CERCA.lat, DESTINO_CERCA.lng]);
    return rows[0];
  };

  test('un pedido con tarjeta sin capturar no aparece en la lista del negocio', async () => {
    const { token: tokenNegocio } = await login('negocio');
    const pedido = await insertarPedidoTarjeta('pendiente');
    pedidoId = pedido.id;

    const lista = await cliente.get('/pedidos/negocio/mis-pedidos', conAuth(tokenNegocio));
    const idsVisibles = lista.data.data.pedidos.map((p) => p.id);
    expect(idsVisibles).not.toContain(pedidoId);
  });

  test('el mismo pedido SÍ aparece una vez que pago_estado pasa a capturado', async () => {
    const { token: tokenNegocio } = await login('negocio');
    const pedido = await insertarPedidoTarjeta('pendiente');
    pedidoId = pedido.id;

    await db.query(`UPDATE pedidos SET pago_estado = 'capturado' WHERE id = $1`, [pedidoId]);

    const lista = await cliente.get('/pedidos/negocio/mis-pedidos', conAuth(tokenNegocio));
    const idsVisibles = lista.data.data.pedidos.map((p) => p.id);
    expect(idsVisibles).toContain(pedidoId);
  });

  test('la API rechaza un pedido con tarjeta mientras el método está apagado', async () => {
    const { token } = await login('cliente');
    const res = await crearPedido(token, { metodo_pago: 'tarjeta' });
    expect(res.status).toBe(400);
    expect(res.data.codigo).toBe('METODO_PAGO_DESACTIVADO');
  });
});

describe('Fase de prueba real — efectivo, tope $700 y pickup', () => {
  const creados = [];
  afterAll(async () => {
    if (creados.length) await db.query(`DELETE FROM pedidos WHERE id = ANY($1)`, [creados]);
  });

  // Desde 2026-08-04 el cliente no puede mandar OTRO pedido mientras el
  // restaurante no conteste el anterior. Estos tests encadenan pedidos, así
  // que borran el previo antes de crear el siguiente — si no, el segundo
  // choca contra ese candado (409) en vez de probar lo que quiere probar.
  const soltarCandado = async () => {
    await db.query(`DELETE FROM pedidos WHERE cliente_id = (SELECT id FROM usuarios WHERE telefono = '0000000002') AND estado = 'pendiente'`);
  };
  beforeEach(soltarCandado);

  test('el tope de efectivo es $700 de productos', async () => {
    const { token } = await login('cliente');
    // 30 × $22 = $660 → pasa (con el tope viejo de $500 habría fallado)
    const ok = await crearPedido(token, { items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 30 }] });
    expect(ok.status).toBe(201);
    creados.push(ok.data.data.pedido.id);

    // 33 × $22 = $726 → se rechaza
    await soltarCandado();
    const excede = await crearPedido(token, { items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 33 }] });
    expect(excede.status).toBe(400);
    expect(excede.data.mensaje).toMatch(/700/);
  });

  test('pickup se crea sin dirección ni GPS y no cobra envío', async () => {
    const { token } = await login('cliente');
    const res = await cliente.post('/pedidos', {
      negocio_id: NEGOCIO_DON_BETO.id,
      items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 8 }],
      metodo_pago: 'efectivo',
      tipo_envio: 'pickup',
    }, conAuth(token));
    expect(res.status).toBe(201);
    const pedido = res.data.data.pedido;
    creados.push(pedido.id);
    expect(parseFloat(pedido.costo_envio)).toBe(0);
    expect(pedido.direccion_entrega).toMatch(/Recoge en tienda/i);
  });
});

describe('Un pedido a la vez mientras el restaurante no contesta', () => {
  // Regla del dueño (2026-08-04): tras enviar un pedido, el cliente no puede
  // mandar otro hasta que el restaurante lo acepte o lo rechace. Antes solo
  // se frenaba el duplicado EXACTO (mismo negocio y mismo total), así que
  // bastaba cambiar la cantidad para dejarle a la cocina varios encima.
  const creados = [];

  const limpiar = async () => {
    await db.query(`DELETE FROM pedidos WHERE cliente_id = (SELECT id FROM usuarios WHERE telefono = '0000000002')`);
  };
  beforeAll(limpiar);
  afterAll(async () => {
    await limpiar();
    creados.length = 0;
  });

  test('el segundo pedido se rechaza aunque cambie el importe', async () => {
    const { token } = await login('cliente');
    const primero = await crearPedido(token, { items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 8 }] });
    expect(primero.status).toBe(201);
    creados.push(primero.data.data.pedido.id);

    const segundo = await crearPedido(token, { items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 9 }] });
    expect(segundo.status).toBe(409);
    expect(segundo.data.codigo).toBe('PEDIDO_ESPERANDO_RESPUESTA');
    // Y NO se creó nada: el candado no puede dejar un pedido a medias.
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS c FROM pedidos WHERE cliente_id = (SELECT id FROM usuarios WHERE telefono = '0000000002')`);
    expect(rows[0].c).toBe(1);
  });

  test('tampoco a otro negocio distinto', async () => {
    const { token } = await login('cliente');
    // Sigue vivo el pedido del test anterior (mismo describe, sin limpiar).
    const otro = await crearPedido(token, {
      negocio_id: NEGOCIO_DON_BETO.id,
      items: [{ producto_id: PRODUCTO_QUESADILLA, cantidad: 4 }],
      tipo_envio: 'pickup',
    });
    expect(otro.status).toBe(409);
    expect(otro.data.codigo).toBe('PEDIDO_ESPERANDO_RESPUESTA');
  });

  test('en cuanto el restaurante ACEPTA, el cliente puede volver a pedir', async () => {
    const { token: tCliente } = await login('cliente');
    const { token: tNegocio } = await login('negocio');
    const confirmado = await cliente.patch(
      `/pedidos/${creados[0]}/estado`, { estado: 'confirmado' }, conAuth(tNegocio));
    expect(confirmado.status).toBe(200);

    // Importe DISTINTO al del pedido ya confirmado: con el mismo total y el
    // mismo negocio saltaría el candado anti-duplicado (que devuelve el
    // pedido existente con 200), y no estaríamos probando lo que queremos.
    const nuevo = await crearPedido(tCliente, { items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 11 }] });
    expect(nuevo.status).toBe(201);
    creados.push(nuevo.data.data.pedido.id);
  });

  test('y si lo RECHAZA, también', async () => {
    const { token: tCliente } = await login('cliente');
    const { token: tNegocio } = await login('negocio');
    // El pedido nuevo del test anterior sigue en 'pendiente'.
    const rechazado = await cliente.patch(
      `/pedidos/${creados[1]}/estado`, { estado: 'rechazado', nota: 'prueba automatizada' }, conAuth(tNegocio));
    expect(rechazado.status).toBe(200);

    const otroMas = await crearPedido(tCliente, { items: [{ producto_id: PRODUCTO_PASTOR, cantidad: 13 }] });
    expect(otroMas.status).toBe(201);
    creados.push(otroMas.data.data.pedido.id);
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

  test('la ruta del mapa en vivo solo la ve quien participa en el pedido', async () => {
    const { token: tokenCliente } = await login('cliente');
    const { token: tokenRepartidor } = await login('repartidor');

    // El cliente dueño del pedido sí puede pedirla. `ruta` puede venir null
    // (Google responde denegado mientras el proyecto no tenga facturación);
    // lo que se verifica aquí es el permiso y la forma de la respuesta.
    const propio = await cliente.get(`/pedidos/${pedidoId}/ruta`, conAuth(tokenCliente));
    expect(propio.status).toBe(200);
    expect(propio.data.data).toHaveProperty('ruta');

    // Un repartidor que NO está asignado a este pedido, no.
    const ajeno = await cliente.get(`/pedidos/${pedidoId}/ruta`, conAuth(tokenRepartidor));
    expect(ajeno.status).toBe(403);

    // Y sin sesión, tampoco.
    const anonimo = await cliente.get(`/pedidos/${pedidoId}/ruta`);
    expect(anonimo.status).toBe(401);
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
      // pedidos_efectivo_pendientes también lo incrementa procesarEntrega
      // junto con deuda_plataforma (commit 9e00317) — revertir solo la
      // deuda y no el contador lo dejaba creciendo sin límite cada vez que
      // corría la suite, hasta bloquear la cuenta de prueba sola.
      await db.query(`UPDATE negocios SET deuda_plataforma = GREATEST(0, deuda_plataforma - 35), pedidos_efectivo_pendientes = GREATEST(0, pedidos_efectivo_pendientes - 1) WHERE id = $1`, [NEGOCIO_DON_BETO.id]);
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
  // Fixture de pruebas PERMANENTE y dedicada (usuario 0000000005 + su propio
  // negocio) — antes este test dependía de un negocio real de un usuario de
  // prueba personal (5545074460), y se rompió cuando ese perfil se reseteó
  // (2026-07-25). Ahora es independiente de cualquier cuenta real.
  const SEGUNDO_NEGOCIO = { id: '33333333-0000-0000-0000-000000000002' };
  const creados = [];

  afterAll(async () => {
    // Borra los pedidos de prueba y cierra la ruta que quedó abierta — si no,
    // el repartidor de prueba arranca la siguiente corrida con un batch
    // 'active' fantasma (mismo patrón del bug real de batches sin cerrar).
    if (creados.length) {
      await db.query(`DELETE FROM pedidos WHERE id = ANY($1)`, [creados]);
    }
    await db.query(`
      UPDATE delivery_batches SET status = 'completed', completed_at = NOW()
      WHERE status = 'active'
        AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.batch_id = delivery_batches.id
                          AND p.estado NOT IN ('entregado','cancelado','rechazado'))`);
  });

  // Crea un pedido 'listo' directo en DB (bypass del flujo de negocio, solo
  // para probar la lógica del lado del repartidor).
  const crearPedidoListo = async ({ negocioId, destino, sufijo }) => {
    const { usuario: cli } = await login('cliente');
    const codigo = String(Math.floor(1000 + Math.random() * 9000));
    const numero = `MND-T${sufijo}${Date.now()}`.slice(0, 12);
    const r = await db.query(`
      INSERT INTO pedidos (numero, cliente_id, negocio_id, items, subtotal, costo_envio, total, metodo_pago, pago_estado, estado, tipo_envio, ciudad, codigo_entrega, fee_cliente, direccion_entrega, latitud_entrega, longitud_entrega)
      VALUES ($1, $2, $3, '[]'::jsonb, 200, 40, 240, 'efectivo', 'pendiente', 'listo', 'standard', '${CIUDAD}', $4, 40, 'Test automatizado — ignorar', $5, $6)
      RETURNING id
    `, [numero, cli.id, negocioId, codigo, destino?.lat ?? null, destino?.lng ?? null]);
    creados.push(r.rows[0].id);
    return r.rows[0].id;
  };

  test('SÍ puede sumar un segundo pedido que va por su mismo rumbo', async () => {
    pedidoDonBeto = await crearPedidoListo({ negocioId: NEGOCIO_DON_BETO.id, destino: DESTINO_CERCA, sufijo: 'A' });
    // Misma zona de entrega (~200 m del primero) → debe permitirse
    const segundo = await crearPedidoListo({
      negocioId: NEGOCIO_DON_BETO.id,
      destino: { lat: DESTINO_CERCA.lat + 0.002, lng: DESTINO_CERCA.lng + 0.002 },
      sufijo: 'B',
    });

    const { token: tokenRep } = await login('repartidor');
    const aceptar1 = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: pedidoDonBeto }, conAuth(tokenRep));
    expect(aceptar1.status).toBe(200);

    const aceptar2 = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: segundo }, conAuth(tokenRep));
    expect(aceptar2.status).toBe(200);

    // Los dos deben quedar en la MISMA ruta (mismo batch)
    const { rows } = await db.query(`SELECT batch_id FROM pedidos WHERE id = ANY($1)`, [[pedidoDonBeto, segundo]]);
    expect(rows).toHaveLength(2);
    expect(rows[0].batch_id).toBe(rows[1].batch_id);
    expect(rows[0].batch_id).toBeTruthy();
  });

  test('NO puede sumar un pedido cuya entrega queda lejos de su ruta', async () => {
    // Mismo negocio, pero la entrega es al otro extremo (~3.5 km): antes esto
    // pasaba solo por ser el mismo restaurante.
    const lejano = await crearPedidoListo({
      negocioId: NEGOCIO_DON_BETO.id,
      destino: { lat: 15.8950, lng: -97.1000 },
      sufijo: 'C',
    });
    const { token: tokenRep } = await login('repartidor');
    const res = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: lejano }, conAuth(tokenRep));
    expect(res.status).toBe(409);
    expect(res.data.codigo).toBe('FUERA_DE_RUTA');
    expect(res.data.mensaje).toMatch(/km/i);
  });

  test('NO puede sumar un pedido sin coordenadas (no se puede verificar la ruta)', async () => {
    const sinCoords = await crearPedidoListo({ negocioId: NEGOCIO_DON_BETO.id, destino: null, sufijo: 'D' });
    const { token: tokenRep } = await login('repartidor');
    const res = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: sinCoords }, conAuth(tokenRep));
    expect(res.status).toBe(409);
    expect(res.data.codigo).toBe('FUERA_DE_RUTA');
    expect(res.data.mensaje).toMatch(/coordenadas/i);
  });

  test('NO puede recoger en un negocio lejano aunque la entrega quede cerca', async () => {
    // Mariscos La Lupita está a ~1.9 km de Don Beto (arriba del máximo de 1.5)
    pedidoSaborAMi = await crearPedidoListo({
      negocioId: SEGUNDO_NEGOCIO.id,
      destino: { lat: DESTINO_CERCA.lat + 0.001, lng: DESTINO_CERCA.lng },
      sufijo: 'E',
    });
    const { token: tokenRep } = await login('repartidor');
    const res = await cliente.post('/repartidores/aceptar-pedido', { pedido_id: pedidoSaborAMi }, conAuth(tokenRep));
    expect(res.status).toBe(409);
    expect(res.data.codigo).toBe('FUERA_DE_RUTA');
    expect(res.data.mensaje).toMatch(/tienda/i);
  });
});
