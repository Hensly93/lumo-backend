// aciertos_prediccion.js - Historial de aciertos: compara lo que NICOLE predijo con lo que realmente se vendio.
// Para cada dia ya pasado toma la ULTIMA prediccion hecha antes de ese dia (normalmente la del dia anterior)
// y la compara con la venta real. Dias sin ventas registradas no cuentan (no se puede medir).

const MIN_DIAS = 3;
const TOLERANCIA = 0.15; // "acerto" = quedo dentro de +-15% de lo vendido

async function calcularAciertos(pool, negocio_id, sucursal_id = null, dias = 30) {
  const d = Math.min(Math.max(parseInt(dias) || 30, 7), 90);
  const r = await pool.query(
    `WITH pred AS (
       SELECT DISTINCT ON (fecha_target::date)
              fecha_target::date AS dia, valor_predicho::float AS predicho, fecha_prediccion::date AS hecha,
              (senales_usadas::jsonb ->> 'rango_min')::float AS rmin, (senales_usadas::jsonb ->> 'rango_max')::float AS rmax
       FROM predicciones_negocio
       WHERE negocio_id = $1
         AND sucursal_id IS NOT DISTINCT FROM $2::integer
         AND fecha_target::date < (NOW() - INTERVAL '3 hours')::date
         AND fecha_target::date >= (NOW() - INTERVAL '3 hours')::date - $3::integer
         AND fecha_prediccion::date < fecha_target::date
       ORDER BY fecha_target::date, fecha_prediccion DESC
     ), vr AS (
       SELECT (fecha - INTERVAL '3 hours')::date AS dia, SUM(monto)::float AS vendido
       FROM transacciones
       WHERE negocio_id = $1
         AND ($2::integer IS NULL OR sucursal_id = $2)
         AND (fecha - INTERVAL '3 hours')::date >= (NOW() - INTERVAL '3 hours')::date - $3::integer
       GROUP BY 1
     )
     SELECT to_char(p.dia, 'YYYY-MM-DD') AS fecha, p.predicho, v.vendido, (p.dia - p.hecha) AS anticipacion, p.rmin, p.rmax
     FROM pred p JOIN vr v ON v.dia = p.dia
     WHERE v.vendido > 0
     ORDER BY p.dia DESC`,
    [negocio_id, sucursal_id, d]
  );
  const detalle = r.rows.map(x => {
    const predicho = Math.round(Number(x.predicho));
    const vendido = Math.round(Number(x.vendido));
    return { fecha: x.fecha, predicho, vendido, error_pct: Math.round(((predicho - vendido) / vendido) * 1000) / 10, anticipacion: Number(x.anticipacion), dentro_rango: (x.rmin == null || x.rmax == null) ? null : (vendido >= Number(x.rmin) && vendido <= Number(x.rmax)) };
  });
  const n = detalle.length;
  if (n < MIN_DIAS) return { dias: n, minimo: MIN_DIAS, detalle };
  const abs = detalle.map(x => Math.abs(x.error_pct));
  const prom = (a) => Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10;
  return {
    dias: n,
    minimo: MIN_DIAS,
    tolerancia_pct: TOLERANCIA * 100,
    error_medio_pct: prom(abs),
    sesgo_pct: prom(detalle.map(x => x.error_pct)),
    acertados: detalle.filter(x => Math.abs(x.error_pct) <= TOLERANCIA * 100).length,
    con_rango: detalle.filter(x => x.dentro_rango !== null).length,
    en_rango: detalle.filter(x => x.dentro_rango === true).length,
    detalle,
  };
}

module.exports = { calcularAciertos };
