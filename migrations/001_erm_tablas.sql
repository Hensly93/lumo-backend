-- ============================================================================
-- LUMO - Migración ERM: Histórico, Feedback y Ajustes
-- Fecha: 2026-07-09
-- Crea las tablas necesarias para el sistema de ERM con ajustes por feedback
-- ============================================================================

-- Tabla: erm_historico
-- Almacena snapshots diarios del score de riesgo de cada empleado
CREATE TABLE IF NOT EXISTS erm_historico (
  id SERIAL PRIMARY KEY,
  negocio_id INT NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id INT NULL REFERENCES mis_sucursales(id) ON DELETE CASCADE,
  empleado TEXT NOT NULL,
  fecha DATE NOT NULL,
  risk_score_bruto NUMERIC NOT NULL,
  factor_aplicado NUMERIC NOT NULL DEFAULT 1.0,
  risk_score_ajustado NUMERIC NOT NULL,
  nivel TEXT NOT NULL,
  senales JSONB NOT NULL,
  turnos_analizados INT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (negocio_id, empleado, fecha)
);

CREATE INDEX IF NOT EXISTS idx_erm_historico_negocio_fecha ON erm_historico(negocio_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_erm_historico_empleado ON erm_historico(negocio_id, empleado);

-- Tabla: erm_feedback
-- Registra el feedback del dueño sobre las alertas de ERM
CREATE TABLE IF NOT EXISTS erm_feedback (
  id SERIAL PRIMARY KEY,
  negocio_id INT NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  empleado TEXT NOT NULL,
  erm_historico_id INT REFERENCES erm_historico(id) ON DELETE SET NULL,
  tipo_feedback TEXT NOT NULL,
  comentario TEXT,
  score_al_momento NUMERIC NOT NULL,
  fecha_feedback TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erm_feedback_negocio ON erm_feedback(negocio_id, empleado, fecha_feedback DESC);

-- Tabla: erm_ajustes
-- Almacena el factor de ajuste por empleado basado en feedback histórico
CREATE TABLE IF NOT EXISTS erm_ajustes (
  id SERIAL PRIMARY KEY,
  negocio_id INT NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  empleado TEXT NOT NULL,
  factor_ajuste NUMERIC NOT NULL DEFAULT 1.0,
  n_feedbacks INT NOT NULL DEFAULT 0,
  ultimo_ajuste TIMESTAMP,
  UNIQUE(negocio_id, empleado)
);

CREATE INDEX IF NOT EXISTS idx_erm_ajustes_negocio ON erm_ajustes(negocio_id);

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================

\echo '=== Tablas ERM creadas ==='
\dt erm_historico
\dt erm_feedback
\dt erm_ajustes

\echo '=== Conteo de registros (deben estar vacías) ==='
SELECT 'erm_historico' AS tabla, COUNT(*) AS registros FROM erm_historico
UNION ALL
SELECT 'erm_feedback', COUNT(*) FROM erm_feedback
UNION ALL
SELECT 'erm_ajustes', COUNT(*) FROM erm_ajustes;

\echo '=== MIGRACIÓN ERM COMPLETADA ==='
