-- 018_codigo_acceso.sql — código de acceso del Modo empleado (reemplaza al número de negocio)
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS codigo_acceso varchar(12);
CREATE UNIQUE INDEX IF NOT EXISTS idx_negocios_codigo_acceso ON negocios (codigo_acceso) WHERE codigo_acceso IS NOT NULL;
