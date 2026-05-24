-- Migración v7: timestamps de revisión y aprobación en negocios y repartidores
ALTER TABLE negocios
  ADD COLUMN IF NOT EXISTS enviado_revision_en TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS resolucion_en        TIMESTAMP WITH TIME ZONE;

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS enviado_revision_en TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS resolucion_en        TIMESTAMP WITH TIME ZONE;
