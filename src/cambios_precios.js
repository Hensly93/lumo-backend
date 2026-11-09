// cambios_precios.js - Registro de quien cambio un precio o un costo (empleado o dueno).
// La tabla se crea sola la primera vez que se usa.
const pool = require('./db');

const UMBRAL_ALERTA_PCT = 15; // cambios de precio de venta de mas de +-15% se marcan para revisar

let listo = false;
async function ensureTabla() {
  if (listo) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS cambios_precios (
    id SERIAL PRIMARY KEY,
    negocio_id INTEGER NOT NULL,
    producto_id INTEGER,
    producto_nombre TEXT,
    campo TEXT NOT NULL,
    valor_anterior NUMERIC,
    valor_nuevo NUMERIC,
    empleado TEXT,
    turno_id INTEGER,
    origen TEXT NOT NULL DEFAULT 'empleado',
    creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cambios_precios_neg ON cambios_precios (negocio_id, creado DESC)');
  listo = true;
}

async function registrarCambio(c) {
  await ensureTabla();
  await pool.query(
    `INSERT INTO cambios_precios (negocio_id, producto_id, producto_nombre, campo, valor_anterior, valor_nuevo, empleado, turno_id, origen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.negocio_id, c.producto_id ?? null, c.producto_nombre ?? null, c.campo, c.valor_anterior ?? null, c.valor_nuevo ?? null,
     c.empleado ?? null, c.turno_id ?? null, c.origen || 'empleado']
  );
}

async function listarCambios(negocio_id, dias = 30) {
  await ensureTabla();
  const r = await pool.query(
    `SELECT id, producto_id, producto_nombre, campo, valor_anterior, valor_nuevo, empleado, origen, creado
     FROM cambios_precios
     WHERE negocio_id = $1 AND creado >= NOW() - ($2::integer * INTERVAL '1 day')
     ORDER BY creado DESC
     LIMIT 200`,
    [negocio_id, dias]
  );
  return r.rows.map(x => {
    const ant = x.valor_anterior == null ? null : Number(x.valor_anterior);
    const nue = x.valor_nuevo == null ? null : Number(x.valor_nuevo);
    const variacion = ant && ant > 0 && nue != null ? Math.round(((nue - ant) / ant) * 1000) / 10 : null;
    return {
      id: x.id,
      producto_id: x.producto_id,
      producto_nombre: x.producto_nombre,
      campo: x.campo,
      valor_anterior: ant,
      valor_nuevo: nue,
      empleado: x.empleado,
      origen: x.origen,
      creado: x.creado,
      variacion_pct: variacion,
      alerta: x.campo === 'precio_venta' && variacion != null && Math.abs(variacion) >= UMBRAL_ALERTA_PCT,
    };
  });
}

module.exports = { registrarCambio, listarCambios, ensureTabla, UMBRAL_ALERTA_PCT };
