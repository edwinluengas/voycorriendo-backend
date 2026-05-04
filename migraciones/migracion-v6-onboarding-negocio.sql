-- ────────────────────────────────────────────────────────────
-- Migracion v6: Onboarding de negocio (Etapa 3)
-- ────────────────────────────────────────────────────────────
-- Permite que cualquier usuario active modo "negocio" desde
-- su perfil y llene un wizard paso a paso (datos basicos,
-- direccion, horarios, documentos, cuenta bancaria) antes de
-- enviar a revision para que el admin lo apruebe.
--
-- Cambios:
--   1) Agregar enum verificacion_estado (espejo del repartidor)
--   2) Agregar columnas para documentos (foto local, RFC, etc.)
--   3) Permitir NULL en campos basicos (los llena el wizard)
--   4) Agregar 'abarrotes' como categoria valida
--
-- IMPORTANTE: Ejecutar cada bloque por separado en el SQL editor
-- de Supabase. Si pegas todo junto y un bloque falla, Postgres
-- hace rollback de todo (se pierde el progreso).
-- ────────────────────────────────────────────────────────────

-- ─── BLOQUE 1: ENUM de verificacion para negocios ───────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'enum_verificacion_negocio'
  ) THEN
    CREATE TYPE enum_verificacion_negocio AS ENUM (
      'pendiente',
      'en_revision',
      'aprobado',
      'rechazado'
    );
  END IF;
END $$;

-- ─── BLOQUE 2: Agregar columnas a negocios ──────────────────
ALTER TABLE negocios
  ADD COLUMN IF NOT EXISTS verificacion_estado enum_verificacion_negocio
    NOT NULL DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS verificacion_nota TEXT,
  ADD COLUMN IF NOT EXISTS foto_local            VARCHAR(500),
  ADD COLUMN IF NOT EXISTS comprobante_domicilio VARCHAR(500),
  ADD COLUMN IF NOT EXISTS documento_rfc         VARCHAR(500),
  ADD COLUMN IF NOT EXISTS documento_ine_dueno   VARCHAR(500);

COMMENT ON COLUMN negocios.verificacion_estado IS
  'Estado del proceso de alta: pendiente (wizard sin terminar), en_revision (esperando admin), aprobado, rechazado.';

-- ─── BLOQUE 3: Permitir NULL en campos basicos ──────────────
-- El wizard guarda paso a paso; al inicio nombre/categoria/direccion
-- estan vacios. Solo se exigen al enviar a revision (validacion en JS).
ALTER TABLE negocios
  ALTER COLUMN nombre    DROP NOT NULL,
  ALTER COLUMN categoria DROP NOT NULL,
  ALTER COLUMN direccion DROP NOT NULL;

-- ─── BLOQUE 4: Marcar como aprobados los negocios existentes ─
-- Cualquier negocio que ya existia antes de este cambio se asume
-- aprobado (porque ya estaba en produccion).
UPDATE negocios
SET verificacion_estado = 'aprobado'
WHERE activo = true
  AND verificacion_estado = 'pendiente';

-- ─── BLOQUE 5: Indice para que admin pueda filtrar pendientes ─
CREATE INDEX IF NOT EXISTS idx_negocios_verificacion
  ON negocios (verificacion_estado, ciudad)
  WHERE verificacion_estado IN ('pendiente', 'en_revision');

-- ────────────────────────────────────────────────────────────
-- LISTO. Ahora el flujo completo es:
--   1) Usuario entra a Perfil → "Activar modo negocio"
--   2) Backend crea fila en negocios con verificacion_estado='pendiente'
--   3) Wizard guarda paso a paso (PATCH /api/negocios/mi-negocio)
--   4) Sube documentos (POST /api/negocios/documento)
--   5) "Enviar a revision" → verificacion_estado='en_revision'
--   6) Admin aprueba (UPDATE activo=true, verificacion_estado='aprobado')
--   7) El dueno puede cambiar a modo negocio en la app
--   8) Desde el dashboard puede abrir/cerrar (abierto_ahora)
-- ────────────────────────────────────────────────────────────
