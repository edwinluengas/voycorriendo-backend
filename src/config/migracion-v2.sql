-- ─────────────────────────────────────────────────────────────
-- VoyCorriendo — Migración v2
-- Ejecutar en Supabase SQL Editor DESPUÉS de la migración anterior
-- (la que ya corrió Edwin con el CHECK de 'ahivoy store').
-- Idempotente: se puede correr varias veces sin romper nada.
-- ─────────────────────────────────────────────────────────────

-- 1. Migrar datos viejos al nuevo esquema
--    (rows con categoria='comida' pasan a 'restaurante';
--     rows con categoria='ahivoy' pasan a 'ahivoy store')
ALTER TABLE negocios DROP CONSTRAINT IF EXISTS negocios_categoria_check;

UPDATE negocios SET categoria = 'restaurante'   WHERE categoria = 'comida';
UPDATE negocios SET categoria = 'ahivoy store'  WHERE categoria = 'ahivoy';

ALTER TABLE negocios
  ADD CONSTRAINT negocios_categoria_check
  CHECK (categoria IN (
    'restaurante',
    'tienda_conveniencia',
    'farmacia',
    'papeleria',
    'panaderia',
    'ahivoy store',
    'distribuidora',
    'otro'
  ));

-- 2. Productos que requieren foto de INE del cliente (alcohol, cigarros, etc.)
ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS requiere_id BOOLEAN DEFAULT FALSE;

-- 3. Pedidos: URL a la foto del INE del cliente (si el pedido tiene productos restringidos)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS ine_foto_url VARCHAR(500);

-- 4. Índice útil para consultar productos restringidos rápido
CREATE INDEX IF NOT EXISTS idx_productos_requiere_id
  ON productos(requiere_id)
  WHERE requiere_id = TRUE;
