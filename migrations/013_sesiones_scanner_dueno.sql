CREATE TABLE sesiones_scanner_dueno (
  id SERIAL PRIMARY KEY,
  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  negocio_id INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL,
  creado_en TIMESTAMP DEFAULT NOW(),
  expira_en TIMESTAMP NOT NULL
);

CREATE INDEX idx_sesiones_scanner_dueno_token ON sesiones_scanner_dueno(token);
