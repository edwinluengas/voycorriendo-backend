-- ═══════════════════════════════════════════════════════
-- VOY CORRIENDO — Esquema completo PostgreSQL
-- Ejecutar UNA sola vez al configurar el servidor
-- ═══════════════════════════════════════════════════════

-- Extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── TABLA: usuarios ────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre              VARCHAR(100) NOT NULL,
    apellido            VARCHAR(100) NOT NULL,
    telefono            VARCHAR(15)  NOT NULL UNIQUE,
    email               VARCHAR(150) UNIQUE,
    password            TEXT,
    rol                 VARCHAR(20)  NOT NULL DEFAULT 'cliente'
                          CHECK (rol IN ('cliente','repartidor','negocio','admin')),
    estado              VARCHAR(20)  NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('activo','inactivo','suspendido','pendiente')),
    foto_perfil         TEXT,
    token_push          TEXT,
    ultima_conexion     TIMESTAMPTZ,
    telefono_verificado BOOLEAN NOT NULL DEFAULT FALSE,
    otp_codigo          VARCHAR(6),
    otp_expira          TIMESTAMPTZ,
    creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_usuarios_telefono ON usuarios(telefono);
CREATE INDEX idx_usuarios_rol      ON usuarios(rol);

-- ─── TABLA: repartidores ────────────────────────────────
CREATE TABLE IF NOT EXISTS repartidores (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id            UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    -- Documentos
    foto_ine_frente       TEXT,
    foto_ine_reverso      TEXT,
    foto_licencia         TEXT,
    foto_tarjeta_circulacion TEXT,
    -- Vehículo
    tipo_vehiculo         VARCHAR(20) DEFAULT 'motocicleta'
                            CHECK (tipo_vehiculo IN ('motocicleta','bicicleta')),
    marca_vehiculo        VARCHAR(50),
    modelo_vehiculo       VARCHAR(50),
    anio_vehiculo         SMALLINT,
    placa_vehiculo        VARCHAR(10),
    color_vehiculo        VARCHAR(30),
    -- Banco
    clabe_bancaria        VARCHAR(18),
    banco                 VARCHAR(50),
    -- Verificación
    verificacion_estado   VARCHAR(20) DEFAULT 'pendiente'
                            CHECK (verificacion_estado IN ('pendiente','en_revision','aprobado','rechazado')),
    verificacion_nota     TEXT,
    antecedentes_ok       BOOLEAN DEFAULT FALSE,
    -- Disponibilidad
    disponible            BOOLEAN DEFAULT FALSE,
    latitud               DECIMAL(10,8),
    longitud              DECIMAL(11,8),
    -- Stats
    calificacion_promedio DECIMAL(3,2) DEFAULT 0.00,
    total_entregas        INTEGER DEFAULT 0,
    ganancias_totales     DECIMAL(12,2) DEFAULT 0.00,
    creado_en             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_repartidores_usuario     ON repartidores(usuario_id);
CREATE INDEX idx_repartidores_disponible  ON repartidores(disponible);
CREATE INDEX idx_repartidores_ubicacion   ON repartidores(latitud, longitud);

-- ─── TABLA: negocios ────────────────────────────────────
CREATE TABLE IF NOT EXISTS negocios (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id           UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nombre               VARCHAR(150) NOT NULL,
    descripcion          TEXT,
    categoria            VARCHAR(30) NOT NULL
                           CHECK (categoria IN ('restaurante','farmacia','abarrotes','distribuidora','otro')),
    logo                 TEXT,
    foto_portada         TEXT,
    -- Ubicación
    direccion            VARCHAR(250) NOT NULL,
    colonia              VARCHAR(100),
    latitud              DECIMAL(10,8),
    longitud             DECIMAL(11,8),
    -- Contacto
    telefono             VARCHAR(15),
    -- Horarios JSON: {"lun":{"abre":"09:00","cierra":"21:00"}, ...}
    horarios             JSONB,
    -- Estado
    activo               BOOLEAN DEFAULT FALSE,
    abierto_ahora        BOOLEAN DEFAULT FALSE,
    tiempo_entrega_min   SMALLINT DEFAULT 20,
    tiempo_entrega_max   SMALLINT DEFAULT 40,
    -- Banco
    clabe_bancaria       VARCHAR(18),
    banco                VARCHAR(50),
    comision_porcentaje  DECIMAL(5,2) DEFAULT 15.00,
    -- Stats
    calificacion_promedio DECIMAL(3,2) DEFAULT 0.00,
    total_pedidos        INTEGER DEFAULT 0,
    creado_en            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_negocios_categoria ON negocios(categoria);
CREATE INDEX idx_negocios_activo    ON negocios(activo);
CREATE INDEX idx_negocios_ubicacion ON negocios(latitud, longitud);

-- ─── TABLA: productos ───────────────────────────────────
CREATE TABLE IF NOT EXISTS productos (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    negocio_id          UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
    nombre              VARCHAR(150) NOT NULL,
    descripcion         TEXT,
    precio              DECIMAL(10,2) NOT NULL CHECK (precio >= 0),
    categoria           VARCHAR(80),
    imagen              TEXT,
    disponible          BOOLEAN DEFAULT TRUE,
    destacado           BOOLEAN DEFAULT FALSE,
    tiempo_preparacion  SMALLINT DEFAULT 10,
    opciones            JSONB,  -- modificadores: sin cebolla, con queso, etc.
    creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_productos_negocio    ON productos(negocio_id);
CREATE INDEX idx_productos_disponible ON productos(disponible);

-- ─── TABLA: pedidos ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS pedidos (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    numero                  VARCHAR(12) NOT NULL UNIQUE,  -- MND-004823
    cliente_id              UUID NOT NULL REFERENCES usuarios(id),
    negocio_id              UUID NOT NULL REFERENCES negocios(id),
    repartidor_id           UUID REFERENCES repartidores(id),
    -- Items (JSON array de productos)
    items                   JSONB NOT NULL,
    -- Montos
    subtotal                DECIMAL(10,2) NOT NULL,
    costo_envio             DECIMAL(10,2) DEFAULT 25.00,
    descuento               DECIMAL(10,2) DEFAULT 0.00,
    total                   DECIMAL(10,2) NOT NULL,
    -- Pago
    metodo_pago             VARCHAR(20) NOT NULL
                              CHECK (metodo_pago IN ('efectivo','tarjeta','transferencia','mercado_pago')),
    pago_estado             VARCHAR(20) DEFAULT 'pendiente'
                              CHECK (pago_estado IN ('pendiente','autorizado','capturado','fallido','reembolsado')),
    pago_referencia         TEXT,
    -- Estado
    estado                  VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                              CHECK (estado IN ('pendiente','confirmado','preparando','listo','en_camino','entregado','cancelado','rechazado')),
    -- Entrega
    direccion_entrega        VARCHAR(250) NOT NULL,
    latitud_entrega          DECIMAL(10,8),
    longitud_entrega         DECIMAL(11,8),
    notas_entrega            TEXT,
    -- Timestamps del flujo
    confirmado_en            TIMESTAMPTZ,
    asignado_en              TIMESTAMPTZ,
    recogido_en              TIMESTAMPTZ,
    entregado_en             TIMESTAMPTZ,
    cancelado_en             TIMESTAMPTZ,
    -- Calificaciones
    calificacion_repartidor  SMALLINT CHECK (calificacion_repartidor BETWEEN 1 AND 5),
    calificacion_negocio     SMALLINT CHECK (calificacion_negocio BETWEEN 1 AND 5),
    comentario               TEXT,
    creado_en                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- REGLA DE NEGOCIO: Efectivo máximo $1,000 MXN
    CONSTRAINT limite_efectivo CHECK (
        metodo_pago != 'efectivo' OR total <= 1000
    )
);
CREATE INDEX idx_pedidos_cliente      ON pedidos(cliente_id);
CREATE INDEX idx_pedidos_negocio      ON pedidos(negocio_id);
CREATE INDEX idx_pedidos_repartidor   ON pedidos(repartidor_id);
CREATE INDEX idx_pedidos_estado       ON pedidos(estado);
CREATE INDEX idx_pedidos_creado       ON pedidos(creado_en DESC);

-- ─── FUNCIÓN: actualizar timestamp automáticamente ──────
CREATE OR REPLACE FUNCTION actualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.actualizado_en = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para auto-actualizar "actualizado_en"
CREATE TRIGGER tg_usuarios_updated    BEFORE UPDATE ON usuarios    FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();
CREATE TRIGGER tg_repartidores_updated BEFORE UPDATE ON repartidores FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();
CREATE TRIGGER tg_negocios_updated    BEFORE UPDATE ON negocios    FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();
CREATE TRIGGER tg_productos_updated   BEFORE UPDATE ON productos   FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();
CREATE TRIGGER tg_pedidos_updated     BEFORE UPDATE ON pedidos     FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();

-- ─── DATOS INICIALES: Admin ─────────────────────────────
-- CAMBIA el password antes de usar en producción
INSERT INTO usuarios (nombre, apellido, telefono, rol, estado, telefono_verificado)
VALUES ('Admin', 'Voy Corriendo', '0000000000', 'admin', 'activo', TRUE)
ON CONFLICT (telefono) DO NOTHING;

-- ═══════════════════════════════════════════════════════
-- ✅ Esquema listo. Ejecuta con:
-- psql -U voycorriendo_user -d voycorriendo_db -f schema.sql
-- ═══════════════════════════════════════════════════════
