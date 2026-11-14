ALTER TABLE empleados_negocio ADD COLUMN IF NOT EXISTS puede_cargar_productos BOOLEAN NOT NULL DEFAULT false;
