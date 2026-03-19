const { getSegmento } = require('./segmentacion');
const { construirBaseline, getConfianzaTemporal } = require('./baseline');

const UMBRAL_ZSCORE = 2.0;

function calcularZScore(valor, media, std) {
  if (std === 0) return 0;
  return (valor - media) / std;
}

function detectarAnomalias(transacciones, empleado) {
  if (!transacciones || transacciones.length === 0) return [];

  const fechas = transacciones.map(t => new Date(t.fecha));
  const diasHistorial = Math.round((Math.max(...fechas) - Math.min(...fechas)) / (1000*60*60*24));
  const confianzaTemporal = getConfianzaTemporal(diasHistorial);
  const baseline = construirBaseline(transacciones);
  const alertas = [];

  transacciones.slice(-50).forEach(t => {
    const seg = getSegmento(t.fecha);
    const clave = `${seg.franja}_${seg.tipoDia}_${seg.quincena}`;
    const base = baseline[clave];
    if (!base || base.n < 3) return;

    const zscore = calcularZScore(Number(t.monto), base.media, base.std);
    if (Math.abs(zscore) >= UMBRAL_ZSCORE) {
      const magnitud = Math.abs(zscore);
      const scoreConfianza = Math.min(confianzaTemporal.score * (magnitud / 3), 1);
      const nivelConfianza = scoreConfianza > 0.8 ? 'ALTA' : scoreConfianza > 0.5 ? 'MEDIA' : 'BAJA';
      const desvio = Math.round(((Number(t.monto) - base.media) / base.media) * 100);

      alertas.push({
        tipo: zscore < 0 ? 'TICKET_BAJO' : 'TICKET_ALTO',
        transaccion_id: t.id,
        monto: t.monto,
        monto_esperado: Math.round(base.media),
        desvio_porcentaje: desvio,
        zscore: Math.round(zscore * 100) / 100,
        segmento: clave,
        empleado: empleado || t.empleado,
        confianza: { nivel: nivelConfianza, score: Math.round(scoreConfianza * 100), label: confianzaTemporal.label },
        fecha: t.fecha
      });
    }
  });

  return alertas;
}

module.exports = { detectarAnomalias };