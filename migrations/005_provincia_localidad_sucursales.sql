-- Agregar provincia_id y localidad_id a mis_sucursales para geocodificación
ALTER TABLE mis_sucursales
ADD COLUMN IF NOT EXISTS provincia_id VARCHAR(2),
ADD COLUMN IF NOT EXISTS localidad_id VARCHAR(20);
