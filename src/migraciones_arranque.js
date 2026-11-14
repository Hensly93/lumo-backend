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

  // 14/11/2026: tablas de Mercado Pago desde el arranque (antes nacían en el primer sync y Fugas fallaba en negocios nuevos)
  try { const { asegurarTablas } = require('./mp_sync'); await asegurarTablas(pool); } catch (e) { console.error('[migraciones] pagos_mp:', e.message); }

  // 13/11/2026: cada venta de la caja queda atada a su turno (ver ventas_turno.js)
  await pool.query('ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS turno_id INTEGER');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tx_turno ON transacciones(turno_id) WHERE turno_id IS NOT NULL');
  // 13/11/2026: el feedback de alertas se busca por negocio + tipo + contexto
  await pool.query('ALTER TABLE alertas_gestionadas ADD COLUMN IF NOT EXISTS negocio_id INTEGER');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alertas_neg_tipo ON alertas_gestionadas(negocio_id, tipo_alerta, contexto, created_at)');
}

module.exports = { ejecutar };
