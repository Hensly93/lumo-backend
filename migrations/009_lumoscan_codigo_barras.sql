-- 009_lumoscan_codigo_barras.sql
-- Agrega soporte para códigos de barras en productos

ALTER TABLE productos ADD COLUMN codigo_barras VARCHAR(64);

CREATE UNIQUE INDEX idx_productos_negocio_codigo_barras
  ON productos(negocio_id, codigo_barras)
  WHERE codigo_barras IS NOT NULL;
