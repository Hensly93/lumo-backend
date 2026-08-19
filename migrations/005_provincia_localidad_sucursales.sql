-- Agregar provincia_id y localidad_id a mis_sucursales para geocodificación
ALTER TABLE mis_sucursales
ADD COLUMN provincia_id VARCHAR(2),
ADD COLUMN localidad_id VARCHAR(20);
