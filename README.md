# 🛵 Voy Corriendo — Backend API

> **Ganador del nombre:** Voy Corriendo 🏆 — energético, mexicano, perfecto para delivery.
> Plataforma de entregas a domicilio en Oaxaca — ciudad piloto: Puerto Escondido.

---

## ⚡ Inicio Rápido (Paso a Paso)

### 1. Requisitos previos (instala si no los tienes)
- [Node.js 18+](https://nodejs.org) — el motor del servidor
- [PostgreSQL 15+](https://www.postgresql.org/download/) — la base de datos
- [Git](https://git-scm.com/) — control de versiones

### 2. Clonar / abrir el proyecto
```bash
cd voycorriendo-backend
npm install
```

### 3. Configurar variables de entorno
```bash
cp .env.example .env
# Abre .env y llena los valores (DB, JWT_SECRET, etc.)
```

### 4. Crear la base de datos en PostgreSQL
```sql
CREATE DATABASE voycorriendo_db;
CREATE USER voycorriendo_user WITH PASSWORD 'tu_password';
GRANT ALL PRIVILEGES ON DATABASE voycorriendo_db TO voycorriendo_user;
```

### 5. Correr el servidor en desarrollo
```bash
npm run dev
# → API corriendo en http://localhost:3000
# → Tablas creadas automáticamente en la BD
```

### 6. Verificar que funciona
```bash
curl http://localhost:3000/api/salud
# Respuesta: { "ok": true, "app": "Voy Corriendo API", ... }
```

---

## 📡 Endpoints de la API

### 🔐 Autenticación (`/api/auth`)
| Método | Ruta              | Descripción                        | Auth |
|--------|-------------------|------------------------------------|------|
| POST   | `/registro`       | Crear cuenta nueva                 | ❌   |
| POST   | `/verificar-otp`  | Verificar número con código SMS    | ❌   |
| POST   | `/solicitar-otp`  | Pedir nuevo código OTP             | ❌   |
| POST   | `/login`          | Iniciar sesión                     | ❌   |
| GET    | `/perfil`         | Ver mi perfil                      | ✅   |

### 🏪 Negocios (`/api/negocios`)
| Método | Ruta                       | Descripción               | Auth        |
|--------|----------------------------|---------------------------|-------------|
| GET    | `/`                        | Listar negocios activos   | ❌          |
| GET    | `/:id`                     | Ver negocio + productos   | ❌          |
| POST   | `/`                        | Registrar mi negocio      | ✅ negocio  |
| PUT    | `/:id`                     | Actualizar mi negocio     | ✅ negocio  |
| POST   | `/:id/productos`           | Agregar producto          | ✅ negocio  |
| PUT    | `/:id/productos/:prod_id`  | Actualizar producto       | ✅ negocio  |

### 📦 Pedidos (`/api/pedidos`)
| Método | Ruta               | Descripción                    | Auth       |
|--------|--------------------|--------------------------------|------------|
| POST   | `/`                | Crear pedido                   | ✅ cliente |
| GET    | `/`                | Mis pedidos                    | ✅         |
| GET    | `/:id`             | Ver pedido detallado           | ✅         |
| PATCH  | `/:id/estado`      | Cambiar estado del pedido      | ✅         |
| POST   | `/:id/calificar`   | Calificar entrega              | ✅ cliente |

### 🛵 Repartidores (`/api/repartidores`)
| Método | Ruta                    | Descripción                       | Auth          |
|--------|-------------------------|-----------------------------------|---------------|
| POST   | `/perfil`               | Completar perfil de repartidor    | ✅ repartidor |
| PATCH  | `/disponibilidad`       | Activar/pausar disponibilidad     | ✅ repartidor |
| GET    | `/mis-entregas`         | Ver historial de entregas         | ✅ repartidor |
| GET    | `/pedidos-disponibles`  | Ver pedidos listos para recoger   | ✅ repartidor |
| POST   | `/aceptar-pedido`       | Aceptar un pedido                 | ✅ repartidor |

---

## 🏗️ Estructura del Proyecto
```
src/
├── config/
│   └── database.js        ← Conexión a PostgreSQL
├── controllers/
│   ├── authController.js      ← Registro, login, OTP
│   ├── negociosController.js  ← CRUD negocios y productos
│   ├── pedidosController.js   ← Ciclo de vida del pedido
│   └── repartidoresController.js ← Perfil y disponibilidad
├── middleware/
│   └── auth.js            ← JWT + control de roles
├── models/
│   ├── index.js           ← Relaciones entre modelos
│   ├── Usuario.js
│   ├── Repartidor.js
│   ├── Negocio.js
│   ├── Producto.js
│   └── Pedido.js
├── routes/
│   ├── auth.routes.js
│   ├── negocios.routes.js
│   ├── pedidos.routes.js
│   └── repartidores.routes.js
└── server.js              ← Punto de entrada + Socket.io
```

---

## 🔌 Tiempo Real (Socket.io)
Los eventos en tiempo real permiten tracking sin recargar la pantalla:

| Evento (emit)            | Quién emite     | Quién escucha   |
|--------------------------|-----------------|-----------------|
| `nuevo_pedido`           | API → negocio   | App negocio     |
| `estado_pedido`          | API → sala      | Cliente         |
| `repartidor_asignado`    | API → sala      | Cliente         |
| `actualizar_ubicacion`   | App repartidor  | Cliente         |
| `ubicacion_repartidor`   | API → sala      | Cliente         |

---

## 🚀 Siguientes Pasos
- [ ] Configurar PostgreSQL localmente
- [ ] Llenar `.env` con credenciales
- [ ] `npm run dev` y probar `/api/salud`
- [ ] Subir a Railway (gratis) para tener servidor en la nube
- [ ] Conectar Mercado Pago sandbox
- [ ] Iniciar app móvil con React Native (Paso 2)
