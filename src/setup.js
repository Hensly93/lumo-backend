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
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS provincia VARCHAR(100)`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ciudad VARCHAR(100)`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS zona VARCHAR(100)`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pos VARCHAR(100)`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS logo TEXT`);

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

    // --- Contexto país / zona / predicciones (S9) ---
    await pool.query(`CREATE TABLE IF NOT EXISTS contexto_pais (
      id SERIAL PRIMARY KEY,
      fecha DATE NOT NULL,
      tipo VARCHAR(50) NOT NULL,
      intensidad DECIMAL(4,2) NOT NULL DEFAULT 1.0,
      descripcion TEXT
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS agregados_zona (
      id SERIAL PRIMARY KEY,
      zona VARCHAR(100),
      tipo_negocio VARCHAR(50),
      semana DATE NOT NULL,
      ticket_promedio DECIMAL(12,2),
      ventas_promedio DECIMAL(12,2),
      negocios_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(zona, tipo_negocio, semana)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS predicciones_negocio (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      sucursal_id INTEGER,
      fecha_prediccion DATE NOT NULL,
      fecha_target DATE NOT NULL,
      valor_predicho DECIMAL(12,2),
      confianza DECIMAL(4,2),
      senales_usadas JSONB,
      horizonte VARCHAR(20),
      mensaje_nicole TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS historial_predicciones (
      id SERIAL PRIMARY KEY,
      prediccion_id INTEGER REFERENCES predicciones_negocio(id),
      valor_real DECIMAL(12,2),
      error_absoluto DECIMAL(12,2),
      error_porcentual DECIMAL(6,2),
      aprendizaje_aplicado BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Poblar contexto_pais con eventos Argentina 2026 (idempotente)
    await pool.query(`
      INSERT INTO contexto_pais (fecha, tipo, intensidad, descripcion) VALUES
      -- Quincenas (cobro salarial 1 y 16 de cada mes)
      ('2026-01-01','quincena',1.15,'Quincena enero'),
      ('2026-01-16','quincena',1.15,'Quincena enero'),
      ('2026-02-01','quincena',1.15,'Quincena febrero'),
      ('2026-02-16','quincena',1.15,'Quincena febrero'),
      ('2026-03-01','quincena',1.15,'Quincena marzo'),
      ('2026-03-16','quincena',1.15,'Quincena marzo'),
      ('2026-04-01','quincena',1.15,'Quincena abril'),
      ('2026-04-16','quincena',1.15,'Quincena abril'),
      ('2026-05-01','quincena',1.15,'Quincena mayo'),
      ('2026-05-16','quincena',1.15,'Quincena mayo'),
      ('2026-06-01','quincena',1.15,'Quincena junio'),
      ('2026-06-16','quincena',1.15,'Quincena junio'),
      ('2026-07-01','quincena',1.15,'Quincena julio'),
      ('2026-07-16','quincena',1.15,'Quincena julio'),
      ('2026-08-01','quincena',1.15,'Quincena agosto'),
      ('2026-08-16','quincena',1.15,'Quincena agosto'),
      ('2026-09-01','quincena',1.15,'Quincena septiembre'),
      ('2026-09-16','quincena',1.15,'Quincena septiembre'),
      ('2026-10-01','quincena',1.15,'Quincena octubre'),
      ('2026-10-16','quincena',1.15,'Quincena octubre'),
      ('2026-11-01','quincena',1.15,'Quincena noviembre'),
      ('2026-11-16','quincena',1.15,'Quincena noviembre'),
      ('2026-12-01','quincena',1.15,'Quincena diciembre'),
      ('2026-12-16','quincena',1.15,'Quincena diciembre'),
      -- Aguinaldo (SAC)
      ('2026-06-30','aguinaldo',1.35,'Aguinaldo junio'),
      ('2026-12-18','aguinaldo',1.35,'Aguinaldo diciembre'),
      -- Feriados nacionales 2026
      ('2026-01-01','feriado',1.00,'Año Nuevo'),
      ('2026-02-16','feriado',1.10,'Carnaval'),
      ('2026-02-17','feriado',1.10,'Carnaval'),
      ('2026-03-24','feriado',0.85,'Día de la Memoria'),
      ('2026-04-02','feriado',0.90,'Día del Veterano de Malvinas'),
      ('2026-04-03','feriado',0.85,'Viernes Santo'),
      ('2026-05-01','feriado',0.85,'Día del Trabajador'),
      ('2026-05-25','feriado',0.90,'Día de la Revolución de Mayo'),
      ('2026-06-20','feriado',0.90,'Paso a la Inmortalidad del Gral. Belgrano'),
      ('2026-07-09','feriado',0.90,'Día de la Independencia'),
      ('2026-08-17','feriado',0.90,'Paso a la Inmortalidad del Gral. San Martín'),
      ('2026-10-12','feriado',0.90,'Día del Respeto a la Diversidad Cultural'),
      ('2026-11-23','feriado',0.90,'Día de la Soberanía Nacional'),
      ('2026-12-08','feriado',0.90,'Inmaculada Concepción de María'),
      ('2026-12-25','feriado',1.05,'Navidad')
      ON CONFLICT DO NOTHING
    `);

    console.log("Base de datos lista");
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}

setup();
