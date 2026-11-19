// se_vende_junto.js — LumoBi · qué productos se compran juntos en el mismo ticket (punto 8 del plan).
//
//   GET /api/se-vende-junto?dias=60
//
// Para cada par de productos cuenta en cuántos tickets aparecen juntos y compara contra lo que pasaría por casualidad ("lift"):
// si A está en el 20% de los tickets y B en el 10%, por casualidad estarían juntos en el 2%. Si están juntos en el 8%, el lift es 4.
// Solo muestra pares con evidencia: al menos 5 tickets juntos, y lift de 1.5 o más. Sin eso, es ruido.
// Anulaciones afuera. Solo tickets de 2 a 15 productos (un ticket de un solo producto no dice nada; uno enorme tampoco).
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { REAL_T } = require('./ventas_sql');

const MIN_JUNTOS = 5;
const MIN_LIFT = 1.5;
const MIN_TICKETS = 40;

// Pura: dado el total de tickets, los de A, los de B y los juntos, calcula las métricas
function metricas(total, a, b, juntos) {
  const esperados = total > 0 ? (a * b) / total : 0;
  return { lift: esperados > 0 ? Math.round((juntos / esperados) * 10) / 10 : null, pct_de_a: a > 0 ? Math.round(juntos / a * 100) : 0, pct_de_b: b > 0 ? Math.round(juntos / b * 100) : 0 };
}

async function calcular(negocioId, dias = 60, db = pool) {
  await require('./anular_venta').asegurar(db);
  const d = Math.min(Math.max(parseInt(dias, 10) || 60, 14), 180);
  const base = `
    WITH tk AS (
      SELECT t.id, ARRAY_AGG(DISTINCT dd.producto_id) AS prods
        FROM transacciones t JOIN transacciones_detalle dd ON dd.transaccion_id = t.id
       WHERE t.negocio_id = $1 AND ${REAL_T} AND COALESCE(t.tipo,'venta') = 'venta' AND dd.producto_id IS NOT NULL
         AND t.fecha >= NOW() - ($2::int || ' days')::interval
         AND NOT EXISTS (SELECT 1 FROM transacciones a WHERE a.anula_id = t.id)
       GROUP BY t.id),
    mt AS (SELECT * FROM tk WHERE CARDINALITY(prods) BETWEEN 2 AND 15)`;
  const tot = (await db.query(`${base} SELECT (SELECT COUNT(*) FROM tk)::int AS tickets, (SELECT COUNT(*) FROM mt)::int AS multi`, [negocioId, d])).rows[0];
  if (tot.tickets < MIN_TICKETS) return { suficiente: false, dias: d, tickets: tot.tickets, pares: [], aviso: `Para ver qué se vende junto hacen falta al menos ${MIN_TICKETS} tickets con productos cargados; hay ${tot.tickets}.` };
  const r = await db.query(`${base},
    freq AS (SELECT p AS id, COUNT(*)::int AS n FROM tk, UNNEST(prods) p GROUP BY p),
    par AS (SELECT a.p AS a, b.p AS b, COUNT(*)::int AS juntos
              FROM mt, UNNEST(prods) a(p), UNNEST(prods) b(p) WHERE a.p < b.p GROUP BY 1, 2 HAVING COUNT(*) >= ${MIN_JUNTOS})
    SELECT par.a, par.b, par.juntos, fa.n AS na, fb.n AS nb, pa.nombre AS nombre_a, pb.nombre AS nombre_b,
           pa.precio_venta::float AS precio_a, pb.precio_venta::float AS precio_b
      FROM par JOIN freq fa ON fa.id = par.a JOIN freq fb ON fb.id = par.b
      JOIN productos pa ON pa.id = par.a AND pa.negocio_id = $1 JOIN productos pb ON pb.id = par.b AND pb.negocio_id = $1
     ORDER BY par.juntos DESC LIMIT 200`, [negocioId, d]);
  const pares = r.rows.map((x) => ({ ...x, ...metricas(tot.tickets, x.na, x.nb, x.juntos) }))
    .filter((x) => x.lift != null && x.lift >= MIN_LIFT)
    .sort((x, y) => (y.juntos * y.lift) - (x.juntos * x.lift)).slice(0, 15)
    .map((x) => ({ a: { id: x.a, nombre: x.nombre_a, precio: x.precio_a }, b: { id: x.b, nombre: x.nombre_b, precio: x.precio_b }, juntos: x.juntos, lift: x.lift, pct_de_a: x.pct_de_a, pct_de_b: x.pct_de_b }));
  return {
    suficiente: true, dias: d, tickets: tot.tickets, tickets_con_varios: tot.multi, pares,
    aviso: 'Solo se muestran pares que aparecen juntos mucho más de lo que pasaría por casualidad. Sirve para armar combos y para poner estos productos cerca en el local.',
  };
}

router.get('/', auth, async (req, res) => {
  try { res.json(await calcular(req.user.negocio_id, req.query.dias)); }
  catch (e) { console.error('se-vende-junto:', e.message); res.status(500).json({ error: 'No pude calcular qué se vende junto.' }); }
});

module.exports = { router, calcular, metricas };
