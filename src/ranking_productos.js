// ranking_productos.js — Qué se vende más y qué se vende menos, y cuánto deja cada producto.
// Sale de las ventas que guarda la caja (transacciones_detalle). No depende de controlar el stock.
// El costo y el nombre son los de ese momento (la "foto" que se guarda en cada venta), no los de hoy.

const pool = require('./db');

const DIAS_OK = [7, 30, 90];

async function ranking(negocioId, dias, db = pool) {
  const d = DIAS_OK.includes(Number(dias)) ? Number(dias) : 30;
  const r = await db.query(
    `SELECT p.id, p.nombre, p.marca, p.stock::float AS stock, p.precio_costo::float AS precio_costo,
            COALESCE(v.unidades, 0)::float AS unidades, COALESCE(v.ingresos, 0)::float AS ingresos,
            v.ganancia::float AS ganancia, v.ultima
       FROM productos p
       LEFT JOIN (
         SELECT dt.producto_id,
                SUM(dt.cantidad) AS unidades, SUM(dt.subtotal) AS ingresos,
                SUM(dt.subtotal - dt.cantidad * dt.costo_unitario) FILTER (WHERE dt.costo_unitario IS NOT NULL AND dt.costo_unitario > 0) AS ganancia,
                MAX(t.fecha) AS ultima
           FROM transacciones_detalle dt JOIN transacciones t ON t.id = dt.transaccion_id
          WHERE t.negocio_id = $1 AND t.tipo = 'venta' AND COALESCE(t.origin, 'real') IN ('real', 'importado')
            AND t.fecha >= NOW() - ($2 || ' days')::interval
          GROUP BY dt.producto_id) v ON v.producto_id = p.id
      WHERE p.negocio_id = $1 AND p.activo = true`, [negocioId, String(d)]);
  const filas = r.rows.map((p) => ({
    id: p.id, nombre: p.nombre, marca: p.marca || null,
    unidades: Math.round(p.unidades * 100) / 100, ingresos: Math.round(p.ingresos),
    ganancia: p.ganancia == null ? null : Math.round(p.ganancia),
    parado: p.stock != null && p.stock > 0 && p.precio_costo > 0 ? Math.round(p.stock * p.precio_costo) : 0,
  }));
  const vendidos = filas.filter((p) => p.unidades > 0);
  const top = (arr, f, n) => arr.slice().sort((a, b) => f(b) - f(a) || a.nombre.localeCompare(b.nombre)).slice(0, n);
  const menos = filas.slice().sort((a, b) => a.unidades - b.unidades || b.parado - a.parado || a.nombre.localeCompare(b.nombre)).slice(0, 10);
  return {
    dias: d,
    productos: filas.length,
    con_ventas: vendidos.length,
    sin_ventas: filas.length - vendidos.length,
    total_unidades: Math.round(vendidos.reduce((s, p) => s + p.unidades, 0) * 100) / 100,
    total_ingresos: vendidos.reduce((s, p) => s + p.ingresos, 0),
    mas_vendidos: top(vendidos, (p) => p.unidades, 10),
    mas_ganancia: top(vendidos.filter((p) => p.ganancia != null), (p) => p.ganancia, 10),
    menos_vendidos: menos,
  };
}

module.exports = { ranking, DIAS_OK };
