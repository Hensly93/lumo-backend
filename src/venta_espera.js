// venta_espera.js — dejar una venta en espera para atender a otro cliente y retomarla después (14/11/2026).
// El carrito se guarda tal cual (productos, varios y descuento) y la caja queda libre.
// Si al cerrar el turno queda alguna en espera, se descarta y queda registrada en la actividad de la caja
// (así no se puede "esconder" una venta en espera sin que el dueño lo vea).
const pool = require('./db');

let listo = null;
function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await require('./caja_extra').asegurar(db);
      await db.query(`CREATE TABLE IF NOT EXISTS ventas_espera (
        id SERIAL PRIMARY KEY,
        turno_id INTEGER NOT NULL,
        items JSONB NOT NULL,
        total NUMERIC(14,2) NOT NULL DEFAULT 0,
        nota TEXT,
        creado TIMESTAMP DEFAULT NOW()
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ventas_espera_turno ON ventas_espera(turno_id)`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

async function guardar(turnoId, nota, db = pool) {
  await asegurar(db);
  const c = await db.query(
    `SELECT producto_id, cantidad, precio_unitario, agregado_por, descripcion, tipo_linea FROM carrito_items WHERE turno_id = $1 ORDER BY id`, [turnoId]);
  if (!c.rows.length) return { ok: false, error: 'El carrito está vacío.' };
  const total = c.rows.reduce((s, x) => s + Number(x.cantidad) * Number(x.precio_unitario), 0);
  const r = await db.query(
    `INSERT INTO ventas_espera (turno_id, items, total, nota) VALUES ($1, $2::jsonb, $3, $4) RETURNING id`,
    [turnoId, JSON.stringify(c.rows), total, nota ? String(nota).slice(0, 60) : null]);
  await db.query(`DELETE FROM carrito_items WHERE turno_id = $1`, [turnoId]);
  return { ok: true, id: r.rows[0].id, total };
}

async function listar(turnoId, db = pool) {
  await asegurar(db);
  const r = await db.query(
    `SELECT id, total::float AS total, nota, to_char(creado - INTERVAL '3 hours','HH24:MI') AS hora,
            jsonb_array_length(items) AS lineas
       FROM ventas_espera WHERE turno_id = $1 ORDER BY id`, [turnoId]);
  return r.rows;
}

async function retomar(turnoId, id, db = pool) {
  await asegurar(db);
  const hay = await db.query(`SELECT 1 FROM carrito_items WHERE turno_id = $1 LIMIT 1`, [turnoId]);
  if (hay.rows.length) return { ok: false, error: 'Primero cobrá o dejá en espera la venta que tenés en el carrito.' };
  const v = await db.query(`DELETE FROM ventas_espera WHERE id = $1 AND turno_id = $2 RETURNING items`, [id, turnoId]);
  if (!v.rows.length) return { ok: false, error: 'Esa venta en espera ya no está.' };
  for (const it of v.rows[0].items) {
    await db.query(
      `INSERT INTO carrito_items (turno_id, producto_id, cantidad, precio_unitario, agregado_por, descripcion, tipo_linea)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [turnoId, it.producto_id || null, it.cantidad, it.precio_unitario, it.agregado_por || 'caja', it.descripcion || null, it.tipo_linea || 'producto']);
  }
  return { ok: true };
}

// Al cerrar el turno: lo que quedó en espera se descarta y se registra para el dueño
async function descartarAlCerrar(turno, db = pool) {
  try {
    await asegurar(db);
    const r = await db.query(`DELETE FROM ventas_espera WHERE turno_id = $1 RETURNING total, items`, [turno.id]);
    for (const v of r.rows) {
      await require('./registro_hechos').registrar({
        negocio_id: turno.negocio_id, turno_id: turno.id, empleado: turno.nombre_empleado, tipo: 'espera_descartada',
        valor: Number(v.total), detalle: { lineas: (v.items || []).length },
      }, db);
    }
    return r.rows.length;
  } catch (e) { console.error('[espera] al cerrar:', e.message); return 0; }
}

module.exports = { asegurar, guardar, listar, retomar, descartarAlCerrar };
