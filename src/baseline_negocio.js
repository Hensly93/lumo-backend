const pool = require('./db');

// dia_semana convención: 0=domingo…6=sábado, 7=global (sin segmentación)
const DIA_GLOBAL = 7;
const MIN_TX_DIA = 5;   // mínimo de transacciones para guardar baseline diario
const MIN_TX_USAR = 10; // mínimo para preferir el baseline diario sobre el global

// Estadísticas robustas: mediana e IQR en lugar de media y desviación estándar
function mediana(valores) {
  if (!valores || valores.length === 0) return null;
  const sorted = [...valores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid-1] + sorted[mid]) / 2 : sorted[mid];
}

function iqr(valores) {
  if (!valores || valores.length < 4) return null;
  const sorted = [...valores].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  return q3 - q1;
}

function calcularMetricasNegocio(transacciones) {
  if (!transacciones || transacciones.length === 0) return null;

  const montos = transacciones.map(t => Number(t.monto)).filter(m => m > 0);
  const ticket_promedio = mediana(montos) ?? 0;
  const ticket_std = iqr(montos);

  const conMetodo = transacciones.filter(t => t.metodo_pago);
  const ratio_efectivo = conMetodo.length > 0
    ? conMetodo.filter(t => t.metodo_pago?.toLowerCase() === 'efectivo').length / conMetodo.length
    : null;

  // std del ratio: calculado sobre los ratios por turno+día (no sobre txs individuales)
  const porTurnoRatio = {};
  conMetodo.forEach(t => {
    const clave = `${t.turno || 'ST'}_${new Date(t.fecha).toISOString().split('T')[0]}`;
    if (!porTurnoRatio[clave]) porTurnoRatio[clave] = { ef: 0, total: 0 };
    porTurnoRatio[clave].total++;
    if (t.metodo_pago?.toLowerCase() === 'efectivo') porTurnoRatio[clave].ef++;
  });
  const ratiosPorTurno = Object.values(porTurnoRatio)
    .filter(r => r.total >= 3)
    .map(r => r.ef / r.total);
  const ratio_std = iqr(ratiosPorTurno);

  const porTurno = {};
  transacciones.forEach(t => {
    const dia = new Date(t.fecha).toISOString().split('T')[0];
    const clave = `${t.turno || 'SIN_TURNO'}_${dia}`;
    porTurno[clave] = (porTurno[clave] || 0) + Number(t.monto);
  });
  const totalesTurno = Object.values(porTurno);
  const ventas_por_turno = mediana(totalesTurno) ?? 0;
  const ventas_std = iqr(totalesTurno);

  return {
    ticket_promedio,  ticket_std,
    ratio_efectivo,   ratio_std,
    ventas_por_turno, ventas_std,
    total: transacciones.length,
  };
}

// Agrupa transacciones por día de semana y calcula métricas de cada grupo
function calcularMetricasPorDia(transacciones) {
  const porDia = {};
  transacciones.forEach(t => {
    const dia = new Date(t.fecha).getDay(); // 0=domingo, 6=sábado
    if (!porDia[dia]) porDia[dia] = [];
    porDia[dia].push(t);
  });
  const resultado = {};
  for (const [dia, txs] of Object.entries(porDia)) {
    const m = calcularMetricasNegocio(txs);
    if (m && m.total >= MIN_TX_DIA) resultado[parseInt(dia)] = m;
  }
  return resultado;
}

async function upsertBaseline(client, usuarioId, diaSemana, metricas) {
  const campos = [
    ['ticket_promedio',  metricas.ticket_promedio,  metricas.ticket_std],
    ['ventas_por_turno', metricas.ventas_por_turno, metricas.ventas_std],
  ];
  if (metricas.ratio_efectivo !== null) {
    campos.push(['ratio_efectivo', metricas.ratio_efectivo, metricas.ratio_std]);
  }
  for (const [metrica, valor, std] of campos) {
    await client.query(
      `INSERT INTO baseline_negocio(usuario_id, metrica, valor, std_dev, total_transacciones, dia_semana, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (usuario_id, metrica, dia_semana) DO UPDATE SET
         valor               = EXCLUDED.valor,
         std_dev             = EXCLUDED.std_dev,
         total_transacciones = EXCLUDED.total_transacciones,
         updated_at          = NOW()`,
      [usuarioId, metrica, valor, std ?? null, metricas.total, diaSemana]
    );
  }
}

async function actualizarBaselineNegocio(usuarioId, transacciones) {
  const global = calcularMetricasNegocio(transacciones);
  if (!global) return;

  const client = await pool.connect();
  try {
    // Global (dia_semana=7)
    await upsertBaseline(client, usuarioId, DIA_GLOBAL, global);

    // Por día de semana (dias con suficientes datos)
    const porDia = calcularMetricasPorDia(transacciones);
    for (const [dia, metricas] of Object.entries(porDia)) {
      await upsertBaseline(client, usuarioId, parseInt(dia), metricas);
    }
  } finally {
    client.release();
  }
}

// Devuelve el baseline del día solicitado (o el del día actual).
// El baseline diario tiene prioridad sobre el global cuando tiene ≥ MIN_TX_USAR transacciones.
async function getBaselineNegocio(usuarioId, diaSemana = null) {
  const dia = diaSemana ?? new Date().getDay();
  const result = await pool.query(
    `SELECT * FROM baseline_negocio WHERE usuario_id=$1 AND dia_semana IN ($2, $3)`,
    [usuarioId, dia, DIA_GLOBAL]
  );

  const global = {};
  const diario = {};
  result.rows.forEach(r => {
    if (r.dia_semana === DIA_GLOBAL) global[r.metrica] = r;
    else diario[r.metrica] = r;
  });

  // Combinar: diario prevalece cuando tiene suficientes datos
  const baseline = { ...global };
  for (const [metrica, row] of Object.entries(diario)) {
    if (parseInt(row.total_transacciones) >= MIN_TX_USAR) {
      baseline[metrica] = row;
    }
  }
  return baseline;
}

module.exports = { calcularMetricasNegocio, actualizarBaselineNegocio, getBaselineNegocio };
