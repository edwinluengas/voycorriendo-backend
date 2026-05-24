-- ═══════════════════════════════════════════════════════
-- VoyCorriendo — Migración v3
-- Ejecutar UNA VEZ en Supabase SQL Editor
-- Idempotente: se puede correr varias veces sin romper nada.
-- ═══════════════════════════════════════════════════════

-- 1. Agregar modo_activo a usuarios
--    (controla en qué modo opera el usuario: cliente, repartidor, negocio, admin)
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS modo_activo VARCHAR(20) NOT NULL DEFAULT 'cliente'
    CHECK (modo_activo IN ('cliente', 'repartidor', 'negocio', 'admin'));

-- 2. Sincronizar modo_activo con el rol de cada usuario existente
UPDATE usuarios SET modo_activo = rol WHERE modo_activo = 'cliente' AND rol != 'cliente';

-- ═══════════════════════════════════════════════════════
-- ✅ Migración lista
-- ═══════════════════════════════════════════════════════
