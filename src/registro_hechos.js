// registro_hechos.js — el registro de hechos de la caja: cada cosa sensible que hace el equipo queda guardada
// (quién, cuándo, qué producto, cuánta plata). Es la memoria con la que LumoBi controla la operación.
//   · item_borrado       sacó un producto del carrito antes de cobrar
//   · cantidad_reducida  bajó la cantidad de un producto en el carrito
//   · precio_cambiado    cambió el precio o el costo de un producto
//   · producto_creado    dio de alta un producto desde la caja
//   · egreso             sacó plata de la caja
// Registrar NUNCA rompe la caja: si algo falla, se ignora y la venta sigue.
const pool = require('./db');

const TIPOS = ['item_borrado', 'cantidad_reducida', 'precio_cambiado', 'producto_creado', 'egreso'];

let lista = null;
function asegurar(db = pool) {
  if (!lista) {
    lista = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS hechos_caja (
        id SERIAL PRIMARY KEY,
        negocio_id INTEGER NOT NULL,
        turno_id INTEGER,
        empleado TEXT,
        tipo TEXT NOT NULL,
        producto_id INTEGER,
        producto_nombre TEXT,
        cantidad NUMERIC(14,3),
        valor NUMERIC(14,2) NOT NULL DEFAULT 0,
        detalle JSONB NOT NULL DEFAULT '{}',
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.query('CREATE INDEX IF NOT EXISTS idx_hechos_caja_neg ON hechos_caja (negocio_id, creado DESC)');
    })().catch((e) => { lista = null; throw e; });
  }
  return lista;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// h: { negocio_id, turno_id, empleado, tipo, producto_id, producto_nombre, cantidad, valor, detalle }
async function registrar(h, db = pool) {
  try {
    if (!h || !h.negocio_id || !TIPOS.includes(h.tipo)) return false;
    await asegurar(db);
    let nombre = h.producto_nombre || null;
    if (!nombre && h.producto_id) {
      const p = await db.query('SELECT nombre FROM productos WHERE id = $1 AND negocio_id = $2', [h.producto_id, h.negocio_id]);
      nombre = p.rows[0] ? p.rows[0].nombre : null;
    }
    await db.query(
      `INSERT INTO hechos_caja (negocio_id, turno_id, empleado, tipo, producto_id, producto_nombre, cantidad, valor, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [h.negocio_id, h.turno_id || null, h.empleado || null, h.tipo, h.producto_id || null, nombre,
       num(h.cantidad), Math.round((num(h.valor) || 0) * 100) / 100, JSON.stringify(h.detalle || {})]);
    return true;
  } catch (e) {
    console.error('[hechos_caja] no se pudo registrar:', e.message);
    return false;
  }
}

// Lectura para el dueño: los últimos hechos del negocio, opcionalmente de un tipo o de una persona.
async function listar(negocioId, { dias = 30, tipo = null, empleado = null, limite = 200 } = {}, db = pool) {
  await asegurar(db);
  const r = await db.query(
    `SELECT id, turno_id, empleado, tipo, producto_id, producto_nombre, cantidad::float AS cantidad, valor::float AS valor, detalle, creado
       FROM hechos_caja
      WHERE negocio_id = $1 AND creado >= NOW() - ($2::int * INTERVAL '1 day')
        AND ($3::text IS NULL OR tipo = $3) AND ($4::text IS NULL OR empleado = $4)
      ORDER BY creado DESC LIMIT $5`,
    [negocioId, Math.min(Math.max(parseInt(dias, 10) || 30, 1), 180), tipo, empleado, Math.min(Math.max(parseInt(limite, 10) || 200, 1), 500)]);
  return r.rows;
}

module.exports = { registrar, listar, asegurar, TIPOS };
