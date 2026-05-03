-- ============================================================
-- VoyCorriendo - Datos de prueba para Puerto Escondido
-- ============================================================
-- Catalogo realista de 15 negocios distribuidos en las zonas
-- principales de Puerto Escondido, con productos representativos.
--
-- Pre-requisito: haber corrido antes 'migracion-v4-ciudad.sql'
-- Ejecutar en el SQL Editor de Supabase, una sola vez.
-- ============================================================

-- ─── 1) LIMPIEZA: borrar datos de prueba viejos de Zacatepec ───
DELETE FROM productos WHERE negocio_id IN (
  '22222222-2222-2222-2222-222222222201',
  '22222222-2222-2222-2222-222222222202',
  '22222222-2222-2222-2222-222222222203'
);
DELETE FROM negocios WHERE id IN (
  '22222222-2222-2222-2222-222222222201',
  '22222222-2222-2222-2222-222222222202',
  '22222222-2222-2222-2222-222222222203'
);

-- ─── 2) Dueño demo (si no existe) ───
INSERT INTO usuarios (id, nombre, apellido, telefono, rol, estado, telefono_verificado, creado_en, actualizado_en)
VALUES ('11111111-1111-1111-1111-111111111111', 'Demo', 'Dueño', '0000000001', 'negocio', 'activo', true, NOW(), NOW())
ON CONFLICT (telefono) DO NOTHING;

-- ─── 3) NEGOCIOS DE PUERTO ESCONDIDO ───
-- Zonas reales:
--   Centro / Adoquin   (15.8631, -97.0676)
--   Zicatela           (15.8534, -97.0530)
--   La Punta           (15.8470, -97.0440)
--   Bacocho            (15.8810, -97.0900)
--   Rinconada          (15.8730, -97.0820)

INSERT INTO negocios (id, usuario_id, nombre, descripcion, categoria, ciudad, direccion, colonia, telefono, latitud, longitud, activo, abierto_ahora, calificacion_promedio, tiempo_entrega_min, tiempo_entrega_max, comision_porcentaje, creado_en, actualizado_en)
VALUES
  -- COMIDA / RESTAURANTES
  ('33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Tacos Don Beto', 'Tacos al pastor, suadero y lengua. Atención de 6pm a 1am.',
   'restaurante', 'puerto_escondido', 'Av. Pérez Gasga s/n, El Adoquín', 'Centro', '9541112233',
   15.8631, -97.0676, true, true, 4.7, 15, 30, 12, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'Mariscos La Lupita', 'Pescado frito, ceviches y aguachiles frescos del día.',
   'restaurante', 'puerto_escondido', 'Calle del Morro 12, Zicatela', 'Zicatela', '9542223344',
   15.8534, -97.0530, true, true, 4.6, 25, 45, 12, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'Pizzería Tigre Negro', 'Pizzas a la leña, pastas frescas y postres caseros.',
   'restaurante', 'puerto_escondido', 'Calle Principal s/n, La Punta', 'La Punta', '9543334455',
   15.8470, -97.0440, true, true, 4.8, 30, 50, 13, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   'Cocina La Hormiga', 'Comida vegetariana y vegana. Bowls, ensaladas y smoothies.',
   'restaurante', 'puerto_escondido', 'Av. Hidalgo 45, Centro', 'Centro', '9544445566',
   15.8625, -97.0690, true, true, 4.5, 20, 40, 12, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111',
   'Café Olas Altas', 'Desayunos para surfistas, café de altura y waffles.',
   'restaurante', 'puerto_escondido', 'Calle del Morro 8, Zicatela', 'Zicatela', '9545556677',
   15.8540, -97.0535, true, true, 4.9, 15, 30, 10, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111',
   'La Hostería de Alcalá', 'Cocina mexicana tradicional. Mole, tlayudas y sopes.',
   'restaurante', 'puerto_escondido', 'Calle 1ra Norte 22, Bacocho', 'Bacocho', '9546667788',
   15.8810, -97.0900, true, true, 4.6, 25, 45, 13, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111',
   'Cevichería El Manatí', 'Ceviches, tostadas y cocteles de mariscos.',
   'restaurante', 'puerto_escondido', 'Av. Pérez Gasga 78, Adoquín', 'Centro', '9547778899',
   15.8635, -97.0680, true, true, 4.4, 20, 35, 12, NOW(), NOW()),

  -- TIENDAS DE CONVENIENCIA / ABARROTES
  ('33333333-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111',
   'Abarrotes Don Pancho', 'Tu tiendita del barrio. Refrescos, botanas, lácteos.',
   'tienda_conveniencia', 'puerto_escondido', 'Calle 5ta Sur 10, Centro', 'Centro', '9548889900',
   15.8628, -97.0672, true, true, 4.3, 15, 30, 10, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111',
   'OXXO Adoquín', 'Tienda 24/7. Bebidas, café, snacks y servicios.',
   'tienda_conveniencia', 'puerto_escondido', 'Av. Pérez Gasga 100, Centro', 'Centro', '9549990011',
   15.8632, -97.0678, true, true, 4.2, 10, 25, 8, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111',
   'Tienda Naturista Verde Mar', 'Productos naturales, suplementos y orgánicos.',
   'otro', 'puerto_escondido', 'Rinconada s/n, Local 3', 'Rinconada', '9540001122',
   15.8730, -97.0820, true, true, 4.5, 20, 40, 10, NOW(), NOW()),

  -- FARMACIAS
  ('33333333-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111',
   'Farmacia Guadalajara', 'Medicamentos, perfumería, baby care.',
   'farmacia', 'puerto_escondido', 'Av. Oaxaca 33, Centro', 'Centro', '9541123344',
   15.8640, -97.0670, true, true, 4.7, 15, 30, 8, NOW(), NOW()),

  ('33333333-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111',
   'Farmacias Similares', 'Medicamentos genéricos y consulta médica.',
   'farmacia', 'puerto_escondido', 'Av. Principal Bacocho s/n', 'Bacocho', '9542234455',
   15.8800, -97.0895, true, true, 4.4, 20, 35, 8, NOW(), NOW()),

  -- PANADERIA
  ('33333333-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111111',
   'Panadería La Espiga', 'Pan dulce, conchas, bolillos y repostería de fiesta.',
   'panaderia', 'puerto_escondido', 'Calle 3ra Norte 14, Centro', 'Centro', '9543345566',
   15.8638, -97.0682, true, true, 4.8, 15, 30, 10, NOW(), NOW()),

  -- PAPELERIA
  ('33333333-0000-0000-0000-000000000014', '11111111-1111-1111-1111-111111111111',
   'Papelería El Estudiante', 'Útiles escolares, copias, impresiones, regalos.',
   'papeleria', 'puerto_escondido', 'Av. Hidalgo 88, Centro', 'Centro', '9544456677',
   15.8625, -97.0685, true, true, 4.5, 20, 40, 8, NOW(), NOW()),

  -- DISTRIBUIDORA
  ('33333333-0000-0000-0000-000000000015', '11111111-1111-1111-1111-111111111111',
   'Distribuidora Costa del Sol', 'Garrafones de agua, carbón, gas LP a domicilio.',
   'distribuidora', 'puerto_escondido', 'Carretera Costera Km 4', 'Bacocho', '9545567788',
   15.8780, -97.0870, true, true, 4.3, 30, 60, 8, NOW(), NOW());

-- ─── 4) PRODUCTOS POR NEGOCIO ───
INSERT INTO productos (id, negocio_id, nombre, descripcion, precio, categoria, disponible, creado_en, actualizado_en)
VALUES
  -- Tacos Don Beto
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000001', 'Taco al pastor', 'Carne al pastor con piña, cilantro y cebolla', 22, 'Tacos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000001', 'Taco de suadero', 'Suadero con cebolla y cilantro', 22, 'Tacos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000001', 'Taco de lengua', 'Lengua de res suave', 28, 'Tacos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000001', 'Quesadilla con bistec', 'Tortilla a mano con queso y bistec', 45, 'Antojitos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000001', 'Refresco 600ml', 'Coca, Sprite, Manzana o Fanta', 25, 'Bebidas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000001', 'Agua de horchata 1L', 'Casera, fría', 35, 'Bebidas', true, NOW(), NOW()),

  -- Mariscos La Lupita
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000002', 'Pescado frito entero', 'Mojarra o huachinango con arroz y ensalada', 220, 'Pescados', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000002', 'Ceviche de pescado', 'Marinado en limón con tomate, cebolla y aguacate', 145, 'Ceviches', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000002', 'Aguachile verde', 'Camarón crudo en salsa de chile serrano', 195, 'Ceviches', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000002', 'Coctel de camarón mediano', 'Camarón pelado en salsa de tomate', 165, 'Cocteles', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000002', 'Cerveza Modelo', '355ml fría', 35, 'Bebidas', true, NOW(), NOW()),

  -- Pizzería Tigre Negro
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000003', 'Pizza Margarita personal', 'Tomate, mozzarella y albahaca fresca', 145, 'Pizzas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000003', 'Pizza Hawaiana mediana', 'Jamón, piña y queso', 215, 'Pizzas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000003', 'Pizza Pepperoni grande', 'Doble pepperoni', 295, 'Pizzas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000003', 'Pasta carbonara', 'Spaghetti con tocino, huevo y queso parmesano', 175, 'Pastas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000003', 'Tiramisú', 'Postre italiano clásico', 95, 'Postres', true, NOW(), NOW()),

  -- Cocina La Hormiga
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000004', 'Bowl Buddha', 'Quinoa, hummus, vegetales rostizados, aguacate', 145, 'Bowls', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000004', 'Hamburguesa de portobello', 'Pan integral, queso vegano, papas al horno', 165, 'Comida principal', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000004', 'Smoothie verde', 'Espinaca, plátano, jengibre, manzana', 75, 'Bebidas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000004', 'Tacos de coliflor', '3 tacos con guacamole', 110, 'Antojitos', true, NOW(), NOW()),

  -- Café Olas Altas
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000005', 'Desayuno surfista', 'Huevos, frijoles, fruta, jugo, café', 135, 'Desayunos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000005', 'Hot cakes con plátano', 'Stack de 3 con miel y mantequilla', 95, 'Desayunos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000005', 'Latte chico', 'Café espresso con leche vaporizada', 45, 'Café', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000005', 'Jugo verde 500ml', 'Apio, manzana, espinaca, limón', 65, 'Bebidas', true, NOW(), NOW()),

  -- La Hostería de Alcalá
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000006', 'Mole negro con pollo', 'Plato típico oaxaqueño con arroz y tortillas', 175, 'Platos fuertes', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000006', 'Tlayuda con cecina', 'Tortilla grande, frijoles, quesillo y cecina', 145, 'Antojitos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000006', 'Sopes de chorizo', '3 piezas con frijol, chorizo, queso y crema', 95, 'Antojitos', true, NOW(), NOW()),

  -- Cevichería El Manatí
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000007', 'Tostada de atún', 'Atún fresco con salsa de soya y aguacate', 75, 'Tostadas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000007', 'Coctel campechana', 'Camarón, pulpo y caracol', 195, 'Cocteles', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000007', 'Ceviche tropical', 'Pescado, mango, chile y cilantro', 155, 'Ceviches', true, NOW(), NOW()),

  -- Abarrotes Don Pancho
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000008', 'Coca-Cola 2L', 'Refresco familiar', 45, 'Bebidas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000008', 'Sabritas grande', 'Bolsa familiar', 38, 'Botanas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000008', 'Tortillas 1 kg', 'De maíz, calientitas', 25, 'Básicos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000008', 'Leche entera 1L', 'Lala', 28, 'Lácteos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000008', 'Huevos 18 piezas', 'Caja jumbo', 78, 'Básicos', true, NOW(), NOW()),

  -- OXXO Adoquín
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000009', 'Café americano', 'Vaso 12oz', 22, 'Café', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000009', 'Sandwich jamón y queso', 'Pan blanco, listo para llevar', 45, 'Comida rápida', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000009', 'Cigarros Marlboro', 'Cajetilla', 85, 'Otros', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000009', 'Recarga Telcel $50', 'Tiempo aire celular', 50, 'Recargas', true, NOW(), NOW()),

  -- Tienda Naturista Verde Mar
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000010', 'Aceite de coco orgánico 250ml', 'Prensado en frío', 145, 'Aceites', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000010', 'Proteína vegana 500g', 'Sabor vainilla', 385, 'Suplementos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000010', 'Miel de abeja 500g', 'Pura, de la sierra', 110, 'Endulzantes', true, NOW(), NOW()),

  -- Farmacia Guadalajara
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000011', 'Paracetamol 500mg', 'Caja con 10 tabletas', 35, 'Medicamentos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000011', 'Ibuprofeno 400mg', 'Caja con 12 tabletas', 55, 'Medicamentos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000011', 'Bloqueador solar SPF 50', 'Resistente al agua, 120ml', 245, 'Cuidado personal', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000011', 'Pañales etapa 3', 'Paquete con 30 piezas', 195, 'Bebés', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000011', 'Suero oral pediátrico', 'Caja con 4 sobres', 65, 'Medicamentos', true, NOW(), NOW()),

  -- Farmacias Similares
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000012', 'Amoxicilina 500mg', 'Caja con 12 cápsulas (genérico)', 75, 'Medicamentos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000012', 'Vitamina C 1g', 'Frasco con 30 tabletas efervescentes', 95, 'Vitaminas', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000012', 'Alcohol gel 500ml', 'Antibacterial', 65, 'Higiene', true, NOW(), NOW()),

  -- Panadería La Espiga
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000013', 'Concha 1 pieza', 'Pan dulce tradicional', 12, 'Pan dulce', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000013', 'Bolillos (10 piezas)', 'Pan blanco para tortas', 35, 'Pan blanco', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000013', 'Pastel chocolate 8 personas', 'Para fiestas, bajo pedido', 385, 'Repostería', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000013', 'Empanada de jamón y queso', '1 pieza', 28, 'Salados', true, NOW(), NOW()),

  -- Papelería El Estudiante
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000014', 'Cuaderno profesional 100h', 'Marca Norma, raya', 45, 'Cuadernos', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000014', 'Caja de colores 12 piezas', 'Marca Crayola', 95, 'Arte', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000014', 'Impresión a color', 'Por hoja, tamaño carta', 8, 'Servicios', true, NOW(), NOW()),

  -- Distribuidora Costa del Sol
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000015', 'Garrafón de agua 20L', 'Marca Ciel, sellado', 45, 'Agua', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000015', 'Carbón vegetal 5 kg', 'Para asadores', 95, 'Combustible', true, NOW(), NOW()),
  (gen_random_uuid(), '33333333-0000-0000-0000-000000000015', 'Tanque de gas 30 kg', 'Recarga a domicilio', 695, 'Gas', true, NOW(), NOW());
