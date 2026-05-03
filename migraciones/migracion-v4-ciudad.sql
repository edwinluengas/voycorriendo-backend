-- ============================================================
-- VoyCorriendo - Migracion v4: Soporte multi-ciudad
-- ============================================================
-- Fecha: 2026-05-02
-- Motivo: Pivot de mercado de Santa Maria Zacatepec a Puerto
-- Escondido como ciudad piloto, dejando preparado el esquema
-- para sumar otras ciudades (Huatulco, Salina Cruz, Oaxaca, etc.)
--
-- Ejecutar UNA sola vez en el SQL Editor de Supabase.
-- ============================================================

-- 1) Agregar columna 'ciudad' a la tabla negocios
ALTER TABLE negocios
  ADD COLUMN IF NOT EXISTS ciudad VARCHAR(50) NOT NULL DEFAULT 'puerto_escondido';

-- 2) Agregar columna 'ciudad' a la tabla repartidores
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS ciudad VARCHAR(50) NOT NULL DEFAULT 'puerto_escondido';

-- 3) Indice para acelerar el filtro por ciudad en consultas del feed
CREATE INDEX IF NOT EXISTS idx_negocios_ciudad_activo
  ON negocios (ciudad, activo);

CREATE INDEX IF NOT EXISTS idx_repartidores_ciudad_disponible
  ON repartidores (ciudad, disponible);

-- 4) Comentarios documentando la columna
COMMENT ON COLUMN negocios.ciudad IS
  'Slug de la ciudad donde opera el negocio. Ej: puerto_escondido, huatulco, salina_cruz';

COMMENT ON COLUMN repartidores.ciudad IS
  'Slug de la ciudad donde opera el repartidor. Mismo formato que negocios.ciudad';
