// migraciones_arranque.js — cambios chicos de base de datos que el servidor aplica solo al arrancar.
// Todo es "si no existe": se puede correr cuantas veces haga falta sin tocar datos.
const pool = require('./db');

async function ejecutar() {
  // Prueba gratis: huellas anti-reingreso (solo hashes) y fechas de la prueba
  await pool.query(`CREATE TABLE IF NOT EXISTS trial_huellas (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(10) NOT NULL,
    hash VARCHAR(64) NOT NULL,
    creado TIMESTAMP DEFAULT NOW(),
    UNIQUE(tipo, hash)
  )`);
  await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trial_inicio TIMESTAMP');
  await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trial_fin TIMESTAMP');
  await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS celular VARCHAR(20)');
}

module.exports = { ejecutar };
