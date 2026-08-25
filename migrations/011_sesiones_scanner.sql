-- 011_sesiones_scanner.sql
-- Sesiones temporales para vincular el escáner con un turno activo

CREATE TABLE sesiones_scanner (
  id SERIAL PRIMARY KEY,
  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  turno_id INTEGER NOT NULL REFERENCES turnos_caja(id),
  negocio_id INTEGER NOT NULL,
  creado_en TIMESTAMP DEFAULT NOW(),
  expira_en TIMESTAMP NOT NULL
);

CREATE INDEX idx_sesiones_scanner_token ON sesiones_scanner(token);
