-- 000_base_negocios.sql — LumoBi
-- Estructura multi-negocio que en producción se creó a mano con psql y nunca quedó en el repo.
-- Todo es "si no existe": correrlo sobre la base de Render no toca nada que ya esté.
-- Orden para rearmar una base vacía: node src/rearmar_db.js

CREATE TABLE IF NOT EXISTS negocios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  tipo_negocio VARCHAR(50),
  provincia VARCHAR(100),
  ciudad VARCHAR(100),
  zona VARCHAR(100),
  created_by INTEGER REFERENCES usuarios(id),
  codigo_acceso VARCHAR(8) UNIQUE,
  plan_id VARCHAR(50),
  subscription_status VARCHAR(30),
  subscription_end_date TIMESTAMP,
  mp_subscription_id VARCHAR(100),
  locales_declarados INTEGER,
  cajas_declaradas INTEGER,
  empleados_declarados INTEGER,
  deletion_scheduled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS negocio_usuarios (
  id SERIAL PRIMARY KEY,
  negocio_id INTEGER NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  rol VARCHAR(20) NOT NULL DEFAULT 'owner',
  activo BOOLEAN DEFAULT true,
  permisos JSONB DEFAULT '{}',
  invitado_por INTEGER REFERENCES usuarios(id),
  fecha_ingreso TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (negocio_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS invitaciones_negocio (
  id SERIAL PRIMARY KEY,
  negocio_id INTEGER NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  email VARCHAR(150) NOT NULL,
  rol VARCHAR(20) DEFAULT 'socio',
  token VARCHAR(100) UNIQUE,
  estado VARCHAR(20) DEFAULT 'pendiente',
  invitado_por INTEGER REFERENCES usuarios(id),
  expira_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- negocio_id en las tablas que nacieron por usuario
ALTER TABLE transacciones     ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE baseline_negocio  ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE baseline_negocio  ADD COLUMN IF NOT EXISTS sucursal_id INTEGER;
ALTER TABLE productos         ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE integraciones_mp  ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE empleados_negocio ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE turnos_caja       ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE conteos_caja      ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE egresos_caja      ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE umbrales_celda    ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE mis_sucursales    ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
ALTER TABLE mis_sucursales    ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_tx_negocio_fecha ON transacciones(negocio_id, fecha);
CREATE INDEX IF NOT EXISTS idx_turnos_negocio ON turnos_caja(negocio_id, estado);
CREATE UNIQUE INDEX IF NOT EXISTS ux_empleados_negocio_nombre ON empleados_negocio(negocio_id, nombre);
CREATE UNIQUE INDEX IF NOT EXISTS ux_integraciones_mp_negocio ON integraciones_mp(negocio_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_umbrales_celda_neg ON umbrales_celda(negocio_id, tipo_turno, dia_semana, condicion);
CREATE UNIQUE INDEX IF NOT EXISTS ux_baseline_neg ON baseline_negocio(negocio_id, COALESCE(sucursal_id, 0), metrica, dia_semana);
