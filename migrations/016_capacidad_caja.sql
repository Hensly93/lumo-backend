-- 016: capacidad de una caja (clientes por hora) por sucursal. NULL = usar referencia del rubro.
ALTER TABLE mis_sucursales ADD COLUMN IF NOT EXISTS capacidad_caja_hora integer NULL CHECK (capacidad_caja_hora > 0);
