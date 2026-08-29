CREATE TABLE codigos_pendientes_dueno (
  id SERIAL PRIMARY KEY,
  negocio_id INTEGER NOT NULL,
  codigo_barras VARCHAR(64) NOT NULL,
  creado_en TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_codigos_pendientes_negocio ON codigos_pendientes_dueno(negocio_id);
