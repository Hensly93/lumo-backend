const pool = require('./db');

function calcularMetricasNegocio(transacciones) {
  if (!transacciones || transacciones.length === 0) return null;

  const montos = transacciones.map(t => Number(t.monto)).filter(m => m > 0);
  const ticket_promedio = montos.length > 0
    ? montos.reduce((a, b) => a + b, 0) / montos.length
    : 0;

  // ratio_efectivo: sólo calculable si hay datos de metodo_pago
  const conMetodo = transacciones.filter(t => t.metodo_pago);
  const ratio_efectivo = conMetodo.length > 0
    ? conMetodo.filter(t => t.metodo_pago?.toLowerCase() === 'efectivo').length / conMetodo.length
    : null;

  // ventas_por_turno: promedio del total de ventas agrupado por turno+día
  const porTurno = {};
  transacciones.forEach(t => {
    const dia = new Date(t.fecha).toISOString().split('T')[0];
    const clave = `${t.turno || 'SIN_TURNO'}_${dia}`;
    porTurno[clave] = (porTurno[clave] || 0) + Number(t.monto);
  });
  const totalesTurno = Object.values(porTurno);
  const ventas_por_turno = totalesTurno.length > 0
    ? totalesTurno.reduce((a, b) => a + b, 0) / totalesTurno.length
    : 0;

  return { ticket_promedio, ratio_efectivo, ventas_por_turno, total: transacciones.length };
}

async function actualizarBaselineNegocio(usuarioId, transacciones) {
  const metricas = calcularMetricasNegocio(transacciones);
  if (!metricas) return;

  const campos = [
    ['ticket_promedio', metricas.ticket_promedio],
    ['ventas_por_turno', metricas.ventas_por_turno],
  ];
  if (metricas.ratio_efectivo !== null) {
    campos.push(['ratio_efectivo', metricas.ratio_efectivo]);
  }

  for (const [metrica, valor] of campos) {
    await pool.query(
      `INSERT INTO baseline_negocio(usuario_id, metrica, valor, total_transacciones, updated_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT (usuario_id, metrica) DO UPDATE SET
         valor=EXCLUDED.valor,
         total_transacciones=EXCLUDED.total_transacciones,
         updated_at=NOW()`,
      [usuarioId, metrica, valor, metricas.total]
    );
  }
}

async function getBaselineNegocio(usuarioId) {
  const result = await pool.query(
    'SELECT * FROM baseline_negocio WHERE usuario_id = $1',
    [usuarioId]
  );
  const baseline = {};
  result.rows.forEach(r => { baseline[r.metrica] = r; });
  return baseline;
}

module.exports = { calcularMetricasNegocio, actualizarBaselineNegocio, getBaselineNegocio };
