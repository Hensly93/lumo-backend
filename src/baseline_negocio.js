// baseline_negocio.js — Lumo v2.0
// Capa 2: baseline propio del negocio construido con transacciones reales.

const pool = require('./db');

/**
 * Calcula métricas agregadas por turno para un negocio específico.
 * Usa los últimos N días de transacciones reales.
 */
async function calcularMetricasNegocio(usuarioId, dias = 30) {
  try {
    const resultado = await pool.query(
      `SELECT 
        DATE(fecha_hora) as fecha,
        turno,
        COUNT(*) as cantidad_tx,
        SUM(monto) as total_ventas,
        SUM(CASE WHEN metodo_pago = 'efectivo' THEN monto ELSE 0 END) as total_efectivo,
        AVG(monto) as ticket_promedio
       FROM transacciones
       WHERE usuario_id = $1
         AND fecha_hora >= NOW() - INTERVAL '${dias} days'
       GROUP BY DATE(fecha_hora), turno
       ORDER BY fecha DESC`,
      [usuarioId]
    );

    return resultado.rows.map(row => ({
      fecha: row.fecha,
      turno: row.turno || 'sin_turno',
      cantidad_tx: parseInt(row.cantidad_tx),
      total_ventas: parseFloat(row.total_ventas) || 0,
      total_efectivo: parseFloat(row.total_efectivo) || 0,
      ticket_promedio: parseFloat(row.ticket_promedio) || 0,
      ratio_efectivo: row.total_ventas > 0
        ? parseFloat(row.total_efectivo) / parseFloat(row.total_ventas)
        : 0,
      ventas_por_turno: parseFloat(row.total_ventas) || 0,
    }));
  } catch (error) {
    console.error('Error calcularMetricasNegocio:', error.message);
    return [];
  }
}

/**
 * Construye el baseline del negocio: mediana y MAD por métrica.
 * Requiere mínimo 7 turnos para ser confiable.
 */
async function getBaselineNegocio(usuarioId, dias = 30) {
  const metricas_data = await calcularMetricasNegocio(usuarioId, dias);

  if (!metricas_data || metricas_data.length < 7) {
    return {
      confiable: false,
      total_turnos: metricas_data.length,
      mensaje: 'Datos insuficientes para baseline propio',
      metricas: null,
    };
  }

  const metricas = ['ticket_promedio', 'ratio_efectivo', 'ventas_por_turno'];
  const baseline = {};

  for (const metrica of metricas) {
    const valores = metricas_data
      .map(d => d[metrica])
      .filter(v => v !== null && !isNaN(v) && v > 0);

    if (valores.length === 0) continue;

    const sorted = [...valores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const mediana = sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;

    const desviaciones = valores.map(v => Math.abs(v - mediana));
    const sortedDev = [...desviaciones].sort((a, b) => a - b);
    const midDev = Math.floor(sortedDev.length / 2);
    const mad = sortedDev.length % 2 !== 0
      ? sortedDev[midDev]
      : (sortedDev[midDev - 1] + sortedDev[midDev]) / 2;

    baseline[metrica] = {
      mediana: parseFloat(mediana.toFixed(2)),
      mad: parseFloat(mad.toFixed(2)),
      n: valores.length,
    };
  }

  return {
    confiable: true,
    total_turnos: met
