// efecto_cambios.js — LumoBi · ¿funcionó el cambio de precio? (punto 7 del plan)
//
//   GET /api/efectos
//
// Para cada cambio de precio de venta que ya tiene 14 días de vida compara las unidades vendidas de ese producto en las 2 semanas
// de antes y en las 2 de después. Para no confundir el efecto del precio con "hubo más gente" o "fue una semana floja", lo compara
// contra el resto del catálogo en las mismas fechas (productos que NO tuvieron cambios de precio cerca). Dos semanas completas
// mantienen la misma mezcla de días de la semana. Si no hay datos para separar el efecto, lo dice y no afirma nada.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { REAL_T } = require('./ventas_sql');

const VENTANA = 14;          // días antes y días después
const MIN_UNIDADES = 20;     // unidades del producto en las 2 semanas de antes
const MIN_CONTROL = 100;     // unidades del resto del catálogo en las 2 semanas de antes
const UMBRAL = 0.05;         // el efecto tiene que mover más del 5% de lo que facturaba para contarlo

// Pura. u = { p_antes, p_desp, c_antes, c_desp }; pv_antes/pv_desp = precios; costo = costo unitario o null.
function veredicto(u, pvAntes, pvDesp, costo) {
  if (u.p_antes < MIN_UNIDADES || u.c_antes < MIN_CONTROL || u.c_desp <= 0) {
    return { resultado: 'pocos_datos', motivo: u.p_antes < MIN_UNIDADES ? `Se vendieron solo ${Math.round(u.p_antes)} unidades en las 2 semanas de antes: poco para medir.` : 'No hay suficiente movimiento del resto del catálogo para comparar.' };
  }
  const ratioControl = u.c_desp / u.c_antes;
  const esperadas = u.p_antes * ratioControl;           // lo que se habría vendido sin tocar el precio, si el producto se movió como el resto
  const unitarioAntes = costo != null ? pvAntes - costo : pvAntes;
  const unitarioDesp = costo != null ? pvDesp - costo : pvDesp;
  const antes = esperadas * unitarioAntes;              // plata (ganancia o ventas) esperada sin cambio
  const despues = u.p_desp * unitarioDesp;              // plata real con el cambio
  const base = Math.abs(u.p_antes * unitarioAntes) || 1;
  const efectoPeriodo = despues - antes;
  const rel = efectoPeriodo / base;
  const mensual = Math.round(efectoPeriodo * 30 / VENTANA);
  const unidadesPct = esperadas > 0 ? Math.round((u.p_desp / esperadas - 1) * 100) : null;
  const resultado = rel > UMBRAL ? 'mejoro' : rel < -UMBRAL ? 'empeoro' : 'sin_efecto_claro';
  return { resultado, mensual, unidades_pct: unidadesPct, sobre: costo != null ? 'ganancia' : 'ventas' };
}

async function calcular(negocioId, db = pool, ahora = new Date()) {
  await require('./anular_venta').asegurar(db);
  await require('./cambios_precios').ensureTabla().catch(() => {});
  const cambios = (await db.query(
    `SELECT c.id, c.producto_id, c.producto_nombre, c.valor_anterior::float AS antes, c.valor_nuevo::float AS nuevo, c.origen, c.creado,
            p.precio_costo::float AS costo
       FROM cambios_precios c LEFT JOIN productos p ON p.id = c.producto_id AND p.negocio_id = c.negocio_id
      WHERE c.negocio_id = $1 AND c.campo = 'precio_venta' AND c.producto_id IS NOT NULL AND c.valor_anterior > 0 AND c.valor_nuevo > 0
        AND c.creado >= $2::timestamptz - INTERVAL '75 days' AND c.creado <= $2::timestamptz - INTERVAL '${VENTANA} days'
      ORDER BY c.creado DESC LIMIT 30`, [negocioId, ahora.toISOString()]).catch(() => ({ rows: [] }))).rows;
  const salida = [];
  for (const c of cambios) {
    const t0 = new Date(c.creado);
    const iso = (d) => new Date(t0.getTime() + d * 86400000).toISOString();
    // Productos con otro cambio de precio cerca: no sirven de control (su venta también se movió por el precio)
    const cercanos = (await db.query(
      `SELECT DISTINCT producto_id FROM cambios_precios WHERE negocio_id = $1 AND campo = 'precio_venta' AND producto_id IS NOT NULL
          AND creado BETWEEN $2::timestamptz AND $3::timestamptz`, [negocioId, iso(-2 * VENTANA), iso(2 * VENTANA)])).rows.map((x) => x.producto_id);
    const u = (await db.query(
      `SELECT
         COALESCE(SUM(d.cantidad) FILTER (WHERE d.producto_id = $2 AND t.fecha >= $3::timestamptz AND t.fecha < $4::timestamptz),0)::float AS p_antes,
         COALESCE(SUM(d.cantidad) FILTER (WHERE d.producto_id = $2 AND t.fecha >= $4::timestamptz AND t.fecha < $5::timestamptz),0)::float AS p_desp,
         COALESCE(SUM(d.cantidad) FILTER (WHERE d.producto_id <> ALL($6::int[]) AND t.fecha >= $3::timestamptz AND t.fecha < $4::timestamptz),0)::float AS c_antes,
         COALESCE(SUM(d.cantidad) FILTER (WHERE d.producto_id <> ALL($6::int[]) AND t.fecha >= $4::timestamptz AND t.fecha < $5::timestamptz),0)::float AS c_desp
       FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
       WHERE t.negocio_id = $1 AND ${REAL_T} AND COALESCE(t.tipo,'venta') = 'venta' AND t.fecha >= $3::timestamptz AND t.fecha < $5::timestamptz
         AND NOT EXISTS (SELECT 1 FROM transacciones a WHERE a.anula_id = t.id)`,
      [negocioId, c.producto_id, iso(-VENTANA), iso(0), iso(VENTANA), [...cercanos, c.producto_id]])).rows[0];
    const v = veredicto(u, c.antes, c.nuevo, c.costo > 0 ? c.costo : null);
    salida.push({
      id: c.id, producto: c.producto_nombre, desde: c.creado, origen: c.origen, de: c.antes, a: c.nuevo,
      unidades_antes: Math.round(u.p_antes), unidades_despues: Math.round(u.p_desp), ...v,
    });
  }
  const medidos = salida.filter((x) => x.resultado !== 'pocos_datos');
  return {
    ventana_dias: VENTANA, cambios: salida,
    resumen: { medidos: medidos.length, mejoraron: medidos.filter((x) => x.resultado === 'mejoro').length, empeoraron: medidos.filter((x) => x.resultado === 'empeoro').length,
      mensual: medidos.reduce((s, x) => s + (x.mensual || 0), 0) },
    aviso: 'Compara 2 semanas antes y 2 después contra el resto del catálogo. No prueba que el cambio sea la causa: puede haber otras razones (una oferta del competidor, el clima). El costo que se usa es el actual.',
  };
}

router.get('/', auth, async (req, res) => {
  try { res.json(await calcular(req.user.negocio_id)); }
  catch (e) { console.error('efectos:', e.message); res.status(500).json({ error: 'No pude medir los cambios de precio.' }); }
});

module.exports = { router, calcular, veredicto };
