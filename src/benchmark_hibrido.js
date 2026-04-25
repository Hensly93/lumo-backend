// Capa 3: transición inteligente entre benchmarks del sector (Capa 1) y baseline propio (Capa 2)

function calcularPesos(totalTransacciones) {
  const peso_capa2 = Math.min(totalTransacciones / 500, 1.0);
  const peso_capa1 = 1 - peso_capa2;
  return { peso_capa1, peso_capa2 };
}

// Promedio de los últimos 7 scores para suavizar la transición
function ventanaMovil7dias(historialScores, scoreActual) {
  const ventana = [...historialScores, scoreActual].slice(-7);
  return ventana.reduce((a, b) => a + b, 0) / ventana.length;
}

function calcularScoreHibrido({ scoreCapa1, scoreCapa2, pesos, historialScores = [] }) {
  const scoreInstante = (scoreCapa1 * pesos.peso_capa1) + (scoreCapa2 * pesos.peso_capa2);
  return ventanaMovil7dias(historialScores, scoreInstante);
}

function determinarCapaOrigen(pesos) {
  if (pesos.peso_capa2 >= 0.8) return 'CAPA2_PROPIO';
  if (pesos.peso_capa1 >= 0.8) return 'CAPA1_SECTOR';
  return 'HIBRIDO';
}

// Z-score de Capa 2: compara valor reciente contra baseline histórico del negocio.
// Usa std_dev real cuando está disponible; proxy fijo solo como fallback.
function calcularZScorePropio(valor, baselineNegocio, metrica) {
  const base = baselineNegocio[metrica];
  if (!base) return 0;
  const referencia = Number(base.valor);
  if (referencia === 0) return 0;
  const std_real = base.std_dev && Number(base.std_dev) > 0 ? Number(base.std_dev) : null;
  const std_proxy = metrica === 'ratio_efectivo' ? 0.10 : referencia * 0.20;
  const std = std_real ?? std_proxy;
  return (valor - referencia) / std;
}

module.exports = { calcularPesos, calcularScoreHibrido, determinarCapaOrigen, calcularZScorePropio };
