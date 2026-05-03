-- ============================================================
-- VoyCorriendo - Migracion v5: Multi-rol + reputacion
-- ============================================================
-- Fecha: 2026-05-03
-- Motivo: Permitir que una sola cuenta pueda ser cliente,
-- repartidor y/o negocio (estilo Uber/Rappi). Sentar la base
-- del sistema de reputacion (estado_cuenta, tasa_cancelacion,
-- tasa_aceptacion, quejas_30d) para auto-suspension futura.
--
-- Ejecutar UNA sola vez en el SQL Editor de Supabase.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1) USUARIOS: agregar 'modo_activo' (modo en que opera AHORA)
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'enum_usuarios_modo_activo'
  ) THEN
    CREATE TYPE enum_usuarios_modo_activo AS ENUM ('cliente', 'repartidor', 'negocio', 'admin');
  END IF;
END$$;

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS modo_activo enum_usuarios_modo_activo NOT NULL DEFAULT 'cliente';

COMMENT ON COLUMN usuarios.modo_activo IS
  'Modo en el que el usuario esta operando ahora (cliente/repartidor/negocio). Cambia con el switch del menu.';

-- ─────────────────────────────────────────────────────────────
-- 2) ENUM compartido para estado_cuenta
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'enum_estado_cuenta'
  ) THEN
    CREATE TYPE enum_estado_cuenta AS ENUM (
      'normal',
      'observacion',
      'probation',
      'suspendido',
      'bloqueado'
    );
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────
-- 3) REPARTIDORES: campos de reputacion + conexion
-- ─────────────────────────────────────────────────────────────
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS estado_cuenta enum_estado_cuenta NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS estado_motivo TEXT,
  ADD COLUMN IF NOT EXISTS tasa_cancelacion DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS tasa_aceptacion DECIMAL(5,2) NOT NULL DEFAULT 100.00,
  ADD COLUMN IF NOT EXISTS quejas_30d INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conectado BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conectado_desde TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN repartidores.estado_cuenta IS
  'Estado operativo (estilo Uber). normal=ok, observacion=coaching, probation=algoritmo lo penaliza, suspendido=no recibe, bloqueado=cuenta cerrada';
COMMENT ON COLUMN repartidores.conectado IS
  'TRUE si el repartidor presiono "Conectarme". Solo si esta TRUE se le asignan pedidos.';

-- Indice para acelerar la busqueda del repartidor mas cercano
CREATE INDEX IF NOT EXISTS idx_repartidores_conectado_estado
  ON repartidores (conectado, estado_cuenta, ciudad)
  WHERE conectado = true;

-- ─────────────────────────────────────────────────────────────
-- 4) NEGOCIOS: campos de reputacion + badge destacado
-- ─────────────────────────────────────────────────────────────
ALTER TABLE negocios
  ADD COLUMN IF NOT EXISTS estado_cuenta enum_estado_cuenta NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS estado_motivo TEXT,
  ADD COLUMN IF NOT EXISTS tasa_cancelacion DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS tiempo_prep_promedio_min INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quejas_30d INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS destacado_calidad BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN negocios.estado_cuenta IS
  'Estado operativo (estilo DoorDash/Rappi). normal=visible, suspendido=oculto del feed';
COMMENT ON COLUMN negocios.destacado_calidad IS
  'Badge "Top" / "Mas pedido" en el feed. Lo asigna el algoritmo segun calificacion + volumen';

-- ─────────────────────────────────────────────────────────────
-- 5) Backfill: usuarios que YA son repartidores o negocios
--    deben tener su modo_activo coincidiendo con su rol viejo
-- ─────────────────────────────────────────────────────────────
UPDATE usuarios SET modo_activo = rol
WHERE rol IN ('cliente', 'repartidor', 'negocio', 'admin')
  AND modo_activo IS DISTINCT FROM rol;

-- ─────────────────────────────────────────────────────────────
-- LISTO. La app ya puede:
--  • Consultar /api/usuarios/mis-roles para saber que modos
--    tiene activos un usuario
--  • Cambiar el modo_activo desde el switch del perfil
--  • Filtrar repartidores por (conectado, estado_cuenta) para
--    asignacion inteligente
--  • Ocultar negocios con estado_cuenta='suspendido' del feed
-- ─────────────────────────────────────────────────────────────
