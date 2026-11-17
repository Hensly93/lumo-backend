// acceso_rapido.js — la grilla de productos de la caja (panadería, verdulería, fiambrería, productos sueltos o sin código).
// El dueño marca con una estrella los productos que vende seguido sin código de barras; el empleado los ve como botones grandes.
// La columna se crea sola la primera vez (mismo patrón que catalogo_marca.js), así no hace falta correr nada a mano.
const pool = require('./db');

const MAX_RAPIDOS = 40;   // más que esto la grilla deja de ser rápida
let listo = null;

function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await db.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS acceso_rapido BOOLEAN NOT NULL DEFAULT false,
                      ADD COLUMN IF NOT EXISTS orden_rapido INTEGER`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

// Productos de la grilla de un negocio, en el orden que armó el dueño
async function listar(negocioId, db = pool) {
  await asegurar(db);
  const r = await db.query(
    `SELECT id, nombre, marca, categoria, precio_venta, unidad
       FROM productos
      WHERE negocio_id = $1 AND COALESCE(activo, true) = true AND acceso_rapido = true
      ORDER BY orden_rapido NULLS LAST, nombre
      LIMIT $2`,
    [negocioId, MAX_RAPIDOS]
  );
  return r.rows;
}

// Pone o saca un producto de la grilla. Devuelve { ok, error?, producto? }
async function marcar(negocioId, productoId, valor, db = pool) {
  await asegurar(db);
  const quiere = valor === true || valor === 'true';
  if (quiere) {
    const n = await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(MAX(orden_rapido), 0) AS max
         FROM productos WHERE negocio_id = $1 AND acceso_rapido = true AND COALESCE(activo, true) = true`,
      [negocioId]
    );
    const ya = await db.query(`SELECT acceso_rapido FROM productos WHERE id = $1 AND negocio_id = $2`, [productoId, negocioId]);
    if (ya.rowCount === 0) return { ok: false, status: 404, error: 'Producto no encontrado' };
    if (!ya.rows[0].acceso_rapido && n.rows[0].n >= MAX_RAPIDOS) {
      return { ok: false, status: 400, error: `La grilla tiene lugar para ${MAX_RAPIDOS} productos. Sacá alguno para sumar otro.` };
    }
    const r = await db.query(
      `UPDATE productos SET acceso_rapido = true, orden_rapido = COALESCE(orden_rapido, $3)
        WHERE id = $1 AND negocio_id = $2
        RETURNING id, nombre, acceso_rapido`,
      [productoId, negocioId, Number(n.rows[0].max) + 1]
    );
    return { ok: true, producto: r.rows[0] };
  }
  const r = await db.query(
    `UPDATE productos SET acceso_rapido = false, orden_rapido = NULL
      WHERE id = $1 AND negocio_id = $2
      RETURNING id, nombre, acceso_rapido`,
    [productoId, negocioId]
  );
  if (r.rowCount === 0) return { ok: false, status: 404, error: 'Producto no encontrado' };
  return { ok: true, producto: r.rows[0] };
}

module.exports = { asegurar, listar, marcar, MAX_RAPIDOS };
