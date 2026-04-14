-- ============================
-- SEEDS DE PRUEBA VOY CORRIENDO
-- ============================

-- ADMIN
INSERT INTO usuarios (id, nombre, apellido, telefono, email, password, rol, estado, telefono_verificado)
VALUES (
    uuid_generate_v4(), 'Admin', 'Sistema', '0000000000', 'admin@voycorriendo.com',
    'admin123', 'admin', 'activo', TRUE
)
ON CONFLICT (telefono) DO NOTHING;

-- CLIENTE
INSERT INTO usuarios (id, nombre, apellido, telefono, email, password, rol, estado, telefono_verificado)
VALUES (
    uuid_generate_v4(), 'Carlos', 'Ramírez', '5512345678', 'carlos@example.com',
    'cliente123', 'cliente', 'activo', TRUE
)
ON CONFLICT (telefono) DO NOTHING;

-- REPARTIDOR
INSERT INTO usuarios (id, nombre, apellido, telefono, email, password, rol, estado, telefono_verificado)
VALUES (
    uuid_generate_v4(), 'Luis', 'Martínez', '5598765432', 'luis@example.com',
    'repartidor123', 'repartidor', 'activo', TRUE
)
ON CONFLICT (telefono) DO NOTHING;

-- NEGOCIO (usuario dueño)
INSERT INTO usuarios (id, nombre, apellido, telefono, email, password, rol, estado, telefono_verificado)
VALUES (
    uuid_generate_v4(), 'Ana', 'Gómez', '5588887777', 'ana@tacosmex.com',
    'negocio123', 'negocio', 'activo', TRUE
)
ON CONFLICT (telefono) DO NOTHING;

-- REPARTIDOR DETALLES
INSERT INTO repartidores (
    id, usuario_id, tipo_vehiculo, marca_vehiculo, modelo_vehiculo, anio_vehiculo,
    placa_vehiculo, color_vehiculo, disponible, latitud, longitud, antecedentes_ok
)
SELECT
    uuid_generate_v4(), u.id, 'motocicleta', 'Italika', 'FT150', 2022,
    'ABC123', 'Rojo', TRUE, 19.4326, -99.1332, TRUE
FROM usuarios u
WHERE telefono = '5598765432'
ON CONFLICT DO NOTHING;

-- NEGOCIO
INSERT INTO negocios (
    id, usuario_id, nombre, descripcion, categoria, direccion, colonia,
    latitud, longitud, telefono, horarios, activo, abierto_ahora
)
SELECT
    uuid_generate_v4(), u.id, 'Tacos El Güero', 'Los mejores tacos al pastor',
    'restaurante', 'Av. Reforma 123', 'Centro',
    19.4330, -99.1400, '5588887777',
    '{
        "lun":{"abre":"09:00","cierra":"23:00"},
        "mar":{"abre":"09:00","cierra":"23:00"},
        "mie":{"abre":"09:00","cierra":"23:00"},
        "jue":{"abre":"09:00","cierra":"23:00"},
        "vie":{"abre":"09:00","cierra":"02:00"},
        "sab":{"abre":"09:00","cierra":"02:00"},
        "dom":{"abre":"10:00","cierra":"22:00"}
    }'::jsonb,
    TRUE, TRUE
FROM usuarios u
WHERE telefono = '5588887777'
ON CONFLICT DO NOTHING;

-- PRODUCTOS
INSERT INTO productos (id, negocio_id, nombre, descripcion, precio, categoria, imagen, disponible, destacado)
SELECT
    uuid_generate_v4(), n.id, 'Taco al Pastor', 'Taco tradicional con piña', 18.00,
    'tacos', NULL, TRUE, TRUE
FROM negocios n
WHERE nombre = 'Tacos El Güero'
ON CONFLICT DO NOTHING;

INSERT INTO productos (id, negocio_id, nombre, descripcion, precio, categoria, imagen, disponible)
SELECT
    uuid_generate_v4(), n.id, 'Gringa', 'Tortilla de harina con pastor y queso', 45.00,
    'tacos', NULL, TRUE
FROM negocios n
WHERE nombre = 'Tacos El Güero'
ON CONFLICT DO NOTHING;

INSERT INTO productos (id, negocio_id, nombre, descripcion, precio, categoria, imagen, disponible)
SELECT
    uuid_generate_v4(), n.id, 'Agua de Horchata', 'Vaso grande', 25.00,
    'bebidas', NULL, TRUE
FROM negocios n
WHERE nombre = 'Tacos El Güero'
ON CONFLICT DO NOTHING;

-- PEDIDO DE PRUEBA
INSERT INTO pedidos (
    id, numero, cliente_id, negocio_id, repartidor_id, items,
    subtotal, costo_envio, descuento, total,
    metodo_pago, pago_estado, estado,
    direccion_entrega, latitud_entrega, longitud_entrega
)
SELECT
    uuid_generate_v4(),
    'MND-000001',
    c.id,
    n.id,
    r.id,
    '[
        {"producto":"Taco al Pastor","cantidad":3,"precio":18.00},
        {"producto":"Agua de Horchata","cantidad":1,"precio":25.00}
    ]'::jsonb,
    79.00, 25.00, 0.00, 104.00,
    'efectivo', 'pendiente', 'pendiente',
    'Calle Falsa 123', 19.4300, -99.1350
FROM usuarios c
JOIN negocios n ON n.nombre = 'Tacos El Güero'
JOIN repartidores r ON r.disponible = TRUE
WHERE c.telefono = '5512345678'
ON CONFLICT DO NOTHING;