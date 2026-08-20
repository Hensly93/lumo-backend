CREATE TABLE productos_historico_precios (
  id SERIAL PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  negocio_id INTEGER NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  precio_anterior NUMERIC(12,2),
  precio_nuevo NUMERIC(12,2) NOT NULL,
  fecha_cambio TIMESTAMP DEFAULT NOW(),
  origen TEXT NOT NULL CHECK (origen IN ('creacion_inicial', 'manual', 'carga_masiva'))
);

CREATE INDEX idx_historico_precios_producto ON productos_historico_precios(producto_id, fecha_cambio DESC);
CREATE INDEX idx_historico_precios_negocio ON productos_historico_precios(negocio_id, fecha_cambio DESC);
