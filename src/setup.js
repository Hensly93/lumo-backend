require("dotenv").config();
const pool = require("./db");
const { poblarBenchmarksSector } = require("./benchmarks_sector");

async function setup() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS usuarios(id SERIAL PRIMARY KEY,nombre VARCHAR(100) NOT NULL,email VARCHAR(100) UNIQUE NOT NULL,password VARCHAR(255) NOT NULL,negocio VARCHAR(100) NOT NULL,created_at TIMESTAMP DEFAULT NOW())`);

    await pool.query(`CREATE TABLE IF NOT EXISTS transacciones(id SERIAL PRIMARY KEY,usuario_id INTEGER REFERENCES usuarios(id),monto DECIMAL(10,2),tipo VARCHAR(50),empleado VARCHAR(100),turno VARCHAR(50),fecha TIMESTAMP DEFAULT NOW(),metodo_pago TEXT)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS benchmarks_sector(
      id SERIAL PRIMARY KEY,
      tipo_negocio VARCHAR(50) NOT NULL,
      metrica VARCHAR(50) NOT NULL,
      valor_min DECIMAL(15,2),
      valor_max DECIMAL(15,2),
      valor_promedio DECIMAL(15,2),
      fuente VARCHAR(200),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(tipo_negocio, metrica)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS baseline_negocio(
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      metrica VARCHAR(50) NOT NULL,
      valor DECIMAL(15,4),
      total_transacciones INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(usuario_id, metrica)
    )`);

    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo_negocio TEXT`);

    await pool.query(`CREATE TABLE IF NOT EXISTS integraciones_mp(
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
      mp_access_token TEXT NOT NULL,
      mp_refresh_token TEXT,
      mp_user_id BIGINT,
      mp_email VARCHAR(200),
      fecha_expiracion TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS mp_payment_id BIGINT`);

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_mp_payment
      ON transacciones(usuario_id, mp_payment_id)
      WHERE mp_payment_id IS NOT NULL`);

    // --- Sistema de control de caja (S7) ---

    await pool.query(`CREATE TABLE IF NOT EXISTS empleados_negocio(
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre VARCHAR(100) NOT NULL,
      pin_hash VARCHAR(255) NOT NULL,
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(usuario_id, nombre)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS turnos_caja(
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      nombre_empleado VARCHAR(100) NOT NULL,
      tipo_turno VARCHAR(20) NOT NULL,
      caja_apertura DECIMAL(12,2) NOT NULL,
      caja_cierre DECIMAL(12,2),
      caja_esperada DECIMAL(12,2),
      brecha DECIMAL(12,2),
      hora_apertura TIMESTAMP DEFAULT NOW(),
      hora_cierre TIMESTAMP,
      estado VARCHAR(20) DEFAULT 'activo',
      conteo_aleatorio_hora TIMESTAMP,
      conteo_aleatorio_respondido BOOLEAN DEFAULT false,
      conteo_aleatorio_omitido BOOLEAN DEFAULT false,
      conteo_aleatorio2_hora TIMESTAMP,
      conteo_aleatorio2_respondido BOOLEAN DEFAULT false,
      conteo_aleatorio2_omitido BOOLEAN DEFAULT false
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS conteos_caja(
      id SERIAL PRIMARY KEY,
      turno_id INTEGER REFERENCES turnos_caja(id),
      tipo VARCHAR(20) NOT NULL,
      monto_declarado DECIMAL(12,2) NOT NULL,
      numero_conteo INTEGER DEFAULT 1,
      hora TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS egresos_caja(
      id SERIAL PRIMARY KEY,
      turno_id INTEGER REFERENCES turnos_caja(id),
      usuario_id INTEGER REFERENCES usuarios(id),
      monto DECIMAL(12,2) NOT NULL,
      motivo TEXT NOT NULL,
      hora TIMESTAMP DEFAULT NOW()
    )`);

    // --- Alert manager (S7 obj7) ---
    const { crearTablaAlertas } = require('./alert_manager');
    await crearTablaAlertas(pool);

    // --- Motor conductual — umbrales dinámicos P6+P7 (S8) ---
    await pool.query(`CREATE TABLE IF NOT EXISTS umbrales_celda(
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      tipo_turno VARCHAR(20) NOT NULL,
      dia_semana INTEGER NOT NULL,
      condicion VARCHAR(20) DEFAULT 'normal',
      umbral_actual DECIMAL(5,2) DEFAULT 2.50,
      n_feedbacks INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(usuario_id, tipo_turno, dia_semana, condicion)
    )`);

    // --- Multi-local (S8) ---
    // Locales propios del dueño (nombre + dirección, sin vinculación a otros usuarios)
    await pool.query(`CREATE TABLE IF NOT EXISTS mis_sucursales(
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre VARCHAR(100) NOT NULL,
      direccion VARCHAR(200),
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Columnas para taggear datos por sucursal (nullable: datos previos quedan sin tag)
    await pool.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS sucursal_id INTEGER REFERENCES mis_sucursales(id)`);
    await pool.query(`ALTER TABLE turnos_caja ADD COLUMN IF NOT EXISTS sucursal_id INTEGER REFERENCES mis_sucursales(id)`);
    await pool.query(`ALTER TABLE empleados_negocio ADD COLUMN IF NOT EXISTS sucursal_id INTEGER REFERENCES mis_sucursales(id)`);

    await poblarBenchmarksSector();

    console.log("Base de datos lista");
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

setup();
