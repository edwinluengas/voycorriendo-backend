-- ═══════════════════════════════════════════════════════
-- MIGRACIÓN: Categorías extendidas + Mi Tienda Ahívoy
-- Ejecutar UNA VEZ en Supabase (SQL Editor)
-- ═══════════════════════════════════════════════════════

-- 1. Reemplazar el CHECK de categorías en negocios
ALTER TABLE negocios DROP CONSTRAINT IF EXISTS negocios_categoria_check;

ALTER TABLE negocios
  ADD CONSTRAINT negocios_categoria_check
  CHECK (categoria IN (
    'restaurante',
    'comida',
    'tienda_conveniencia',
    'farmacia',
    'papeleria',
    'panaderia',
    'ahivoy',
    'distribuidora',
    'otro'
  ));

-- 2. Agregar columna "destacado" para mostrar negocios en carrusel
ALTER TABLE negocios
  ADD COLUMN IF NOT EXISTS destacado BOOLEAN DEFAULT FALSE;

-- 3. Agregar columna "tipo_entrega" (local = moto, paqueteria = envío CDMX)
ALTER TABLE negocios
  ADD COLUMN IF NOT EXISTS tipo_entrega VARCHAR(20) DEFAULT 'local'
    CHECK (tipo_entrega IN ('local', 'paqueteria'));

-- 4. Índice para búsqueda rápida de destacados
CREATE INDEX IF NOT EXISTS idx_negocios_destacado ON negocios(destacado) WHERE destacado = TRUE;

-- ═══════════════════════════════════════════════════════
-- ✅ Migración lista
-- ═══════════════════════════════════════════════════════
