DROP INDEX idx_productos_nombre;
CREATE UNIQUE INDEX IF NOT EXISTS idx_productos_nombre ON productos(negocio_id, nombre) WHERE activo=true;
