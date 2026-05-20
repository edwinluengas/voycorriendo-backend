/**
 * Script para cargar negocios de prueba en la base de datos
 * Uso: node src/scripts/seed-negocios.js
 *
 * Crea negocios representativos de Puerto Escondido, Oaxaca
 * + Mi Tienda Ahívoy (mercado online tipo MercadoLibre, envío desde CDMX)
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const { Usuario, Negocio, Producto } = require('../models');

// Coordenadas aproximadas de Puerto Escondido, Oaxaca
const LAT_BASE = 15.8603;
const LNG_BASE = -97.0731;

const HORARIOS_NORMAL = {
  lun: { abre: '08:00', cierra: '22:00' },
  mar: { abre: '08:00', cierra: '22:00' },
  mie: { abre: '08:00', cierra: '22:00' },
  jue: { abre: '08:00', cierra: '22:00' },
  vie: { abre: '08:00', cierra: '23:00' },
  sab: { abre: '08:00', cierra: '23:00' },
  dom: { abre: '09:00', cierra: '21:00' },
};

const HORARIOS_FARMACIA = {
  lun: { abre: '07:00', cierra: '23:00' },
  mar: { abre: '07:00', cierra: '23:00' },
  mie: { abre: '07:00', cierra: '23:00' },
  jue: { abre: '07:00', cierra: '23:00' },
  vie: { abre: '07:00', cierra: '23:00' },
  sab: { abre: '07:00', cierra: '23:00' },
  dom: { abre: '08:00', cierra: '22:00' },
};

const HORARIOS_AHIVOY = {
  lun: { abre: '00:00', cierra: '23:59' },
  mar: { abre: '00:00', cierra: '23:59' },
  mie: { abre: '00:00', cierra: '23:59' },
  jue: { abre: '00:00', cierra: '23:59' },
  vie: { abre: '00:00', cierra: '23:59' },
  sab: { abre: '00:00', cierra: '23:59' },
  dom: { abre: '00:00', cierra: '23:59' },
};

// ─── NEGOCIOS LOCALES ────────────────────────────────────
const NEGOCIOS = [
  {
    dueno: {
      nombre: 'María', apellido: 'López Hernández',
      telefono: '9531110001', email: 'taqueria.don.chuy@example.com', password: 'negocio123',
    },
    negocio: {
      nombre: 'Taquería Don Chuy',
      descripcion: 'Los mejores tacos al pastor del pueblo. Carbón 100%.',
      categoria: 'restaurante',
      direccion: 'Calle Hidalgo 45, Centro', colonia: 'Centro',
      telefono: '9531110001',
      latitud: LAT_BASE + 0.0010, longitud: LNG_BASE - 0.0015,
      horarios: HORARIOS_NORMAL,
      tiempo_entrega_min: 15, tiempo_entrega_max: 25,
      calificacion_promedio: 4.7, total_pedidos: 128,
      destacado: true, tipo_entrega: 'local',
    },
    productos: [
      { nombre: 'Taco al pastor', descripcion: 'Con piña, cebolla y cilantro', precio: 18, categoria: 'Tacos', destacado: true },
      { nombre: 'Taco de bistec', descripcion: 'Carne de res a la plancha', precio: 20, categoria: 'Tacos' },
      { nombre: 'Taco de chorizo', descripcion: 'Chorizo casero, bien sazonado', precio: 18, categoria: 'Tacos' },
      { nombre: 'Quesadilla al pastor', descripcion: 'Tortilla de harina con queso y pastor', precio: 45, categoria: 'Quesadillas' },
      { nombre: 'Gringas (2 pzas)', descripcion: 'Dos tortillas de harina con queso y pastor', precio: 70, categoria: 'Quesadillas', destacado: true },
      { nombre: 'Alambre especial', descripcion: 'Bistec, pastor, tocino, pimientos y queso', precio: 120, categoria: 'Especialidades' },
      { nombre: 'Coca-Cola 600ml', descripcion: 'Refresco bien frío', precio: 25, categoria: 'Bebidas' },
      {
        nombre: 'Agua fresca 1L',
        descripcion: 'Recién hecha, elige tu sabor',
        precio: 30,
        categoria: 'Bebidas',
        opciones: {
          tipo: 'sabor',
          requerida: true,
          titulo: 'Elige tu sabor',
          valores: ['Jamaica', 'Horchata', 'Tamarindo', 'Limón', 'Piña'],
        },
      },
    ],
  },
  {
    dueno: {
      nombre: 'Roberto', apellido: 'Martínez Cruz',
      telefono: '9531110002', email: 'comida.casera.dona.lupe@example.com', password: 'negocio123',
    },
    negocio: {
      nombre: 'Comida Casera Doña Lupe',
      descripcion: 'Comida corrida con sabor de casa. Menú del día.',
      categoria: 'restaurante',
      direccion: 'Av. Juárez 12, Barrio San Miguel', colonia: 'San Miguel',
      telefono: '9531110002',
      latitud: LAT_BASE - 0.0008, longitud: LNG_BASE + 0.0012,
      horarios: { ...HORARIOS_NORMAL, dom: { abre: '09:00', cierra: '17:00' } },
      tiempo_entrega_min: 20, tiempo_entrega_max: 35,
      calificacion_promedio: 4.8, total_pedidos: 203,
      destacado: true, tipo_entrega: 'local',
    },
    productos: [
      { nombre: 'Menú del día completo', descripcion: 'Sopa, arroz, guisado, frijoles, tortillas y agua', precio: 85, categoria: 'Comida corrida', destacado: true },
      { nombre: 'Mole rojo con pollo', descripcion: 'Mole tradicional oaxaqueño con arroz', precio: 110, categoria: 'Especialidades', destacado: true },
      { nombre: 'Tasajo asado', descripcion: 'Carne asada con frijoles y tortillas', precio: 130, categoria: 'Especialidades' },
      { nombre: 'Tlayuda con tasajo', descripcion: 'Tlayuda grande con frijol, quesillo, tasajo y salsa', precio: 95, categoria: 'Antojitos' },
      { nombre: 'Empanadas de amarillo (3 pzas)', descripcion: 'Rellenas de mole amarillo con pollo', precio: 75, categoria: 'Antojitos' },
      { nombre: 'Caldo de pollo', descripcion: 'Con verduras y arroz aparte', precio: 70, categoria: 'Sopas' },
      {
        nombre: 'Agua fresca 1L',
        descripcion: 'Recién hecha todos los días',
        precio: 25,
        categoria: 'Bebidas',
        opciones: {
          tipo: 'sabor',
          requerida: true,
          titulo: 'Elige tu sabor',
          valores: ['Jamaica', 'Horchata', 'Tamarindo', 'Limón', 'Chía con limón'],
        },
      },
    ],
  },
  {
    dueno: {
      nombre: 'Ana', apellido: 'Ramírez Pérez',
      telefono: '9531110003', email: 'farmacia.la.salud@example.com', password: 'negocio123',
    },
    negocio: {
      nombre: 'Farmacia La Salud',
      descripcion: 'Medicamentos de patente y genéricos. Entrega rápida.',
      categoria: 'farmacia',
      direccion: 'Calle Morelos 78, Centro', colonia: 'Centro',
      telefono: '9531110003',
      latitud: LAT_BASE + 0.0005, longitud: LNG_BASE + 0.0008,
      horarios: HORARIOS_FARMACIA,
      tiempo_entrega_min: 15, tiempo_entrega_max: 25,
      calificacion_promedio: 4.6, total_pedidos: 89,
      destacado: false, tipo_entrega: 'local',
    },
    productos: [
      { nombre: 'Paracetamol 500mg (caja 10 pzas)', descripcion: 'Para dolor y fiebre', precio: 35, categoria: 'Medicamentos' },
      { nombre: 'Ibuprofeno 400mg (caja 10 pzas)', descripcion: 'Antiinflamatorio', precio: 55, categoria: 'Medicamentos' },
      { nombre: 'Electrolit 625ml', descripcion: 'Suero para rehidratación', precio: 35, categoria: 'Sueros', destacado: true },
      { nombre: 'Alcohol en gel 250ml', descripcion: 'Antibacterial', precio: 45, categoria: 'Higiene' },
      { nombre: 'Cubrebocas tricapa (paquete 10)', descripcion: 'Desechables', precio: 40, categoria: 'Higiene' },
      { nombre: 'Vitamina C 1g (efervescente, 10 pzas)', descripcion: 'Refuerza defensas', precio: 85, categoria: 'Vitaminas' },
      { nombre: 'Termómetro digital', descripcion: 'Medición rápida y segura', precio: 140, categoria: 'Equipo médico' },
      { nombre: 'Curitas (caja 20 pzas)', descripcion: 'Para heridas pequeñas', precio: 30, categoria: 'Primeros auxilios' },
    ],
  },
  {
    dueno: {
      nombre: 'José', apellido: 'Sánchez Gómez',
      telefono: '9531110004', email: 'abarrotes.la.esquina@example.com', password: 'negocio123',
    },
    negocio: {
      nombre: 'Abarrotes La Esquina',
      descripcion: 'Lo que necesites para tu casa. Entregas en todo el pueblo.',
      categoria: 'tienda_conveniencia',
      direccion: 'Esq. Reforma y 5 de Mayo', colonia: 'Centro',
      telefono: '9531110004',
      latitud: LAT_BASE - 0.0012, longitud: LNG_BASE - 0.0005,
      horarios: { ...HORARIOS_NORMAL, vie: { abre: '07:00', cierra: '22:00' } },
      tiempo_entrega_min: 20, tiempo_entrega_max: 40,
      calificacion_promedio: 4.5, total_pedidos: 156,
      destacado: false, tipo_entrega: 'local',
    },
    productos: [
      { nombre: 'Huevo (docena)', descripcion: 'Huevo blanco fresco', precio: 55, categoria: 'Básicos', destacado: true },
      { nombre: 'Tortilla (1 kg)', descripcion: 'Tortilla recién hecha', precio: 25, categoria: 'Básicos', destacado: true },
      { nombre: 'Frijol negro (1 kg)', descripcion: 'Frijol de la región', precio: 40, categoria: 'Granos' },
      { nombre: 'Arroz Morelos (1 kg)', descripcion: 'Arroz de grano largo', precio: 35, categoria: 'Granos' },
      { nombre: 'Aceite de maíz 1L', descripcion: 'Para cocinar', precio: 55, categoria: 'Básicos' },
      { nombre: 'Azúcar estándar (1 kg)', descripcion: '', precio: 28, categoria: 'Básicos' },
      { nombre: 'Coca-Cola 2L', descripcion: 'Refresco familiar', precio: 45, categoria: 'Bebidas' },
      { nombre: 'Leche entera Lala 1L', descripcion: 'Pasteurizada', precio: 28, categoria: 'Lácteos' },
      { nombre: 'Pan Bimbo grande', descripcion: 'Pan blanco 680g', precio: 55, categoria: 'Panificados' },
      { nombre: 'Galletas Marías (paquete)', descripcion: 'Clásicas', precio: 18, categoria: 'Snacks' },

      // ─── Productos con restricción de edad (requieren foto del INE) ───
      {
        nombre: 'Corona 355ml (6-pack)',
        descripcion: 'Cerveza clara, 6 botellas de 355ml',
        precio: 115,
        categoria: 'Cervezas',
        destacado: true,
        requiere_id: true,
      },
      {
        nombre: 'Modelo Especial 355ml (6-pack)',
        descripcion: 'Cerveza pilsner, 6 botellas de 355ml',
        precio: 125,
        categoria: 'Cervezas',
        requiere_id: true,
      },
      {
        nombre: 'Victoria 1.2L (caguama)',
        descripcion: 'Cerveza ámbar',
        precio: 45,
        categoria: 'Cervezas',
        requiere_id: true,
      },
      {
        nombre: 'Tecate Light 473ml',
        descripcion: 'Lata individual',
        precio: 25,
        categoria: 'Cervezas',
        requiere_id: true,
      },
      {
        nombre: 'Cigarros Marlboro Red (cajetilla 20)',
        descripcion: 'Cajetilla de 20 cigarros',
        precio: 85,
        categoria: 'Cigarros',
        requiere_id: true,
      },
      {
        nombre: 'Cigarros Camel Filters (cajetilla 20)',
        descripcion: 'Cajetilla de 20 cigarros',
        precio: 85,
        categoria: 'Cigarros',
        requiere_id: true,
      },
    ],
  },
  {
    dueno: {
      nombre: 'Carmen', apellido: 'Vázquez López',
      telefono: '9531110005', email: 'panaderia.la.espiga@example.com', password: 'negocio123',
    },
    negocio: {
      nombre: 'Panadería La Espiga',
      descripcion: 'Pan dulce y bolillos calientitos. Horneamos toda la tarde.',
      categoria: 'panaderia',
      direccion: 'Calle Independencia 23', colonia: 'Centro',
      telefono: '9531110005',
      latitud: LAT_BASE + 0.0007, longitud: LNG_BASE - 0.0003,
      horarios: {
        lun: { abre: '06:00', cierra: '21:00' }, mar: { abre: '06:00', cierra: '21:00' },
        mie: { abre: '06:00', cierra: '21:00' }, jue: { abre: '06:00', cierra: '21:00' },
        vie: { abre: '06:00', cierra: '22:00' }, sab: { abre: '06:00', cierra: '22:00' },
        dom: { abre: '07:00', cierra: '20:00' },
      },
      tiempo_entrega_min: 15, tiempo_entrega_max: 25,
      calificacion_promedio: 4.9, total_pedidos: 245,
      destacado: true, tipo_entrega: 'local',
    },
    productos: [
      { nombre: 'Bolillo (pza)', descripcion: 'Pan salado crujiente', precio: 4, categoria: 'Pan salado', destacado: true },
      { nombre: 'Concha', descripcion: 'Pan dulce de vainilla o chocolate', precio: 12, categoria: 'Pan dulce', destacado: true },
      { nombre: 'Cuernito', descripcion: 'Pan hojaldrado en forma de media luna', precio: 10, categoria: 'Pan dulce' },
      { nombre: 'Oreja', descripcion: 'Pan con azúcar y canela', precio: 12, categoria: 'Pan dulce' },
      { nombre: 'Rebanada de pastel de tres leches', descripcion: 'Porción individual', precio: 45, categoria: 'Pasteles' },
      { nombre: 'Pastel de chocolate 1 kg', descripcion: 'Cubierto de chocolate', precio: 350, categoria: 'Pasteles' },
      { nombre: 'Docena surtida', descripcion: '12 piezas de pan dulce mixto', precio: 130, categoria: 'Combos', destacado: true },
    ],
  },
  {
    dueno: {
      nombre: 'Luis', apellido: 'Jiménez Ortiz',
      telefono: '9531110006', email: 'papeleria.el.lapiz@example.com', password: 'negocio123',
    },
    negocio: {
      nombre: 'Papelería El Lápiz',
      descripcion: 'Útiles escolares, copias, impresiones y regalos.',
      categoria: 'papeleria',
      direccion: 'Av. Miguel Alemán 56', colonia: 'Centro',
      telefono: '9531110006',
      latitud: LAT_BASE - 0.0003, longitud: LNG_BASE - 0.0010,
      horarios: HORARIOS_NORMAL,
      tiempo_entrega_min: 20, tiempo_entrega_max: 35,
      calificacion_promedio: 4.4, total_pedidos: 42,
      destacado: false, tipo_entrega: 'local',
    },
    productos: [
      { nombre: 'Cuaderno profesional cuadro chico', descripcion: '100 hojas, cosido', precio: 45, categoria: 'Cuadernos', destacado: true },
      { nombre: 'Pluma Bic azul (caja 12)', descripcion: 'Punto mediano', precio: 85, categoria: 'Escritura' },
      { nombre: 'Lápiz #2 Mirado (caja 12)', descripcion: 'Con goma', precio: 65, categoria: 'Escritura' },
      { nombre: 'Hojas blancas tamaño carta (paquete 500)', descripcion: 'Papel bond 75g', precio: 120, categoria: 'Papel' },
      { nombre: 'Tijeras escolares', descripcion: 'Punta redonda, 13 cm', precio: 35, categoria: 'Útiles escolares' },
      { nombre: 'Pegamento Resistol blanco 245g', descripcion: 'Líquido, lavable', precio: 42, categoria: 'Adhesivos' },
      { nombre: 'Juego geométrico', descripcion: 'Regla, escuadra, transportador y compás', precio: 58, categoria: 'Útiles escolares' },
      { nombre: 'Mochila escolar básica', descripcion: 'Con 3 compartimentos', precio: 380, categoria: 'Mochilas' },
      { nombre: 'Impresión blanco y negro (por hoja)', descripcion: 'Documento, texto', precio: 2, categoria: 'Servicios' },
      { nombre: 'Copia tamaño carta', descripcion: 'Una hoja', precio: 1, categoria: 'Servicios' },
    ],
  },

  // ─── 🌟 MI TIENDA AHÍVOY (Mercado online, envío desde CDMX) ───
  {
    dueno: {
      nombre: 'Edwin', apellido: 'Rojas Luengas (Ahívoy)',
      telefono: '9531119999', email: 'mitienda.ahivoy@example.com', password: 'ahivoy123',
    },
    negocio: {
      nombre: 'Mi Tienda Ahívoy',
      descripcion: '🛍️ Tu Mercado Libre en Puerto Escondido. Productos directo de CDMX a tu puerta. Envío 3-5 días por paquetería.',
      categoria: 'ahivoy store',
      direccion: 'Envío desde CDMX — Zona de cobertura: Puerto Escondido y alrededores',
      colonia: 'Centro',
      telefono: '9531119999',
      latitud: LAT_BASE, longitud: LNG_BASE,
      horarios: HORARIOS_AHIVOY,
      tiempo_entrega_min: 4320,   // 3 días en minutos
      tiempo_entrega_max: 7200,   // 5 días en minutos
      calificacion_promedio: 4.9, total_pedidos: 342,
      destacado: true, tipo_entrega: 'paqueteria',
    },
    productos: [
      // Electrónica
      { nombre: 'Audífonos Bluetooth inalámbricos', descripcion: 'Batería 6h, con estuche de carga. Compatible con iOS y Android.', precio: 399, categoria: 'Electrónica', destacado: true },
      { nombre: 'Cargador USB-C rápido 20W', descripcion: 'Carga rápida, ideal para iPhone y Samsung', precio: 189, categoria: 'Electrónica' },
      { nombre: 'Bocina Bluetooth portátil 10W', descripcion: 'Resistente al agua IPX7. 8 horas de uso.', precio: 549, categoria: 'Electrónica', destacado: true },
      { nombre: 'Cable USB-C a Lightning 1m', descripcion: 'Certificado MFi para iPhone', precio: 149, categoria: 'Electrónica' },
      { nombre: 'Power Bank 10,000 mAh', descripcion: 'Carga 3 veces un celular', precio: 329, categoria: 'Electrónica' },
      { nombre: 'Memoria USB 64 GB', descripcion: 'USB 3.0 alta velocidad', precio: 179, categoria: 'Electrónica' },

      // Accesorios celular
      { nombre: 'Funda de silicón para iPhone (varios modelos)', descripcion: 'Suave, anti-huellas', precio: 129, categoria: 'Accesorios celular' },
      { nombre: 'Mica de cristal templado 9H', descripcion: 'Protector de pantalla', precio: 99, categoria: 'Accesorios celular' },
      { nombre: 'Soporte de celular para carro', descripcion: 'Magnético, salida de aire', precio: 149, categoria: 'Accesorios celular' },
      { nombre: 'Aro de luz LED para selfies 26cm', descripcion: '3 tonos de luz, con tripié', precio: 499, categoria: 'Accesorios celular' },

      // Hogar
      { nombre: 'Sartén antiadherente 28cm', descripcion: 'Mango de madera, apto para estufa de gas', precio: 289, categoria: 'Hogar y cocina' },
      { nombre: 'Juego de cuchillos 6 piezas con base', descripcion: 'Acero inoxidable', precio: 549, categoria: 'Hogar y cocina' },
      { nombre: 'Olla exprés 6 litros', descripcion: 'Aluminio, 3 sistemas de seguridad', precio: 789, categoria: 'Hogar y cocina' },
      { nombre: 'Licuadora Oster 10 vel 1.25L', descripcion: 'Vaso de vidrio, motor reforzado', precio: 999, categoria: 'Hogar y cocina', destacado: true },
      { nombre: 'Organizador de cajones 6 divisiones', descripcion: 'Plástico transparente', precio: 149, categoria: 'Hogar y cocina' },

      // Herramientas
      { nombre: 'Juego de desarmadores 12 piezas', descripcion: 'Phillips y planos, mango ergonómico', precio: 269, categoria: 'Herramientas' },
      { nombre: 'Taladro inalámbrico 12V + maletín', descripcion: 'Incluye 2 baterías y 20 brocas', precio: 1299, categoria: 'Herramientas', destacado: true },
      { nombre: 'Cinta métrica 5m', descripcion: 'Con freno y clip', precio: 89, categoria: 'Herramientas' },
      { nombre: 'Juego de llaves españolas 10 piezas', descripcion: 'De 8mm a 22mm, acero cromado', precio: 349, categoria: 'Herramientas' },

      // Belleza
      { nombre: 'Secadora de pelo iónica 2200W', descripcion: '3 temperaturas, difusor incluido', precio: 699, categoria: 'Belleza y cuidado personal' },
      { nombre: 'Plancha para pelo cerámica', descripcion: 'Calentamiento rápido, pantalla digital', precio: 449, categoria: 'Belleza y cuidado personal' },
      { nombre: 'Kit de brochas de maquillaje 12 pzas', descripcion: 'Con estuche, cerdas suaves', precio: 229, categoria: 'Belleza y cuidado personal' },
      { nombre: 'Perfume dama floral 100ml', descripcion: 'Fragancia duradera', precio: 389, categoria: 'Belleza y cuidado personal' },

      // Juguetes
      { nombre: 'Set de Legos compatibles 500 piezas', descripcion: 'Para niños 6+', precio: 459, categoria: 'Juguetes' },
      { nombre: 'Muñeca de moda con accesorios', descripcion: 'Incluye 3 outfits', precio: 299, categoria: 'Juguetes' },
      { nombre: 'Carro de control remoto off-road', descripcion: 'Batería recargable, alcance 30m', precio: 549, categoria: 'Juguetes', destacado: true },

      // Ropa
      { nombre: 'Playera básica cuello redondo (unisex)', descripcion: 'Algodón 100%, tallas S a XL', precio: 159, categoria: 'Ropa y calzado' },
      { nombre: 'Calcetines deportivos (paquete 6 pares)', descripcion: 'Algodón, talla única adulto', precio: 149, categoria: 'Ropa y calzado' },
      { nombre: 'Gorra ajustable snapback', descripcion: 'Varios colores', precio: 189, categoria: 'Ropa y calzado' },

      // Deportes
      { nombre: 'Mancuernas ajustables 10kg (par)', descripcion: 'Discos de 2.5kg y 1.25kg', precio: 799, categoria: 'Deportes' },
      { nombre: 'Ligas de resistencia (set de 5)', descripcion: '5 niveles de resistencia con manijas', precio: 199, categoria: 'Deportes' },
      { nombre: 'Tapete de yoga antideslizante 6mm', descripcion: 'Incluye correa de transporte', precio: 249, categoria: 'Deportes' },

      // Bebé
      { nombre: 'Pañales Huggies etapa 3 (paquete 40)', descripcion: 'Ultra absorbentes', precio: 299, categoria: 'Bebé' },
      { nombre: 'Biberón anti-cólicos 240ml', descripcion: 'Libre de BPA', precio: 129, categoria: 'Bebé' },

      // Varios
      { nombre: 'Cafetera eléctrica 12 tazas', descripcion: 'Jarra de vidrio, filtro permanente', precio: 549, categoria: 'Hogar y cocina' },
      { nombre: 'Báscula digital de baño', descripcion: 'Hasta 180 kg, pantalla LCD', precio: 289, categoria: 'Hogar y cocina' },
    ],
  },
];

// ─── Ejecución ───────────────────────────────────────────
async function sembrar() {
  try {
    console.log('🌱 Iniciando seed de negocios...\n');
    await sequelize.authenticate();
    console.log('✅ Conectado a la base de datos\n');

    let creados = 0;
    let saltados = 0;

    for (const item of NEGOCIOS) {
      // 1. Crear o encontrar dueño del negocio
      let dueno = await Usuario.findOne({ where: { telefono: item.dueno.telefono } });
      if (dueno) {
        console.log(`⏭️  Usuario ${item.dueno.telefono} ya existe, reusando...`);
      } else {
        dueno = await Usuario.create({
          ...item.dueno,
          rol: 'negocio', estado: 'activo', telefono_verificado: true,
        });
        console.log(`✅ Dueño creado: ${dueno.nombre} ${dueno.apellido}`);
      }

      // 2. Crear negocio (si no existe)
      const yaExiste = await Negocio.findOne({ where: { usuario_id: dueno.id } });
      if (yaExiste) {
        console.log(`⏭️  Negocio "${item.negocio.nombre}" ya existe, saltando\n`);
        saltados++;
        continue;
      }

      const negocio = await Negocio.create({
        ...item.negocio,
        usuario_id: dueno.id, activo: true, abierto_ahora: true,
      });
      const destacadoTag = negocio.destacado ? ' ⭐' : '';
      const entregaTag = negocio.tipo_entrega === 'paqueteria' ? ' 📦' : '';
      console.log(`✅ Negocio creado: ${negocio.nombre} [${negocio.categoria}]${destacadoTag}${entregaTag}`);

      // 3. Crear productos
      for (const prod of item.productos) {
        await Producto.create({ ...prod, negocio_id: negocio.id, disponible: true });
      }
      console.log(`   📦 ${item.productos.length} productos agregados\n`);
      creados++;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🎉 Seed completo: ${creados} negocios creados, ${saltados} saltados`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error en seed:', error);
    process.exit(1);
  }
}

sembrar();
