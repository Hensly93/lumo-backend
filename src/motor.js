const { detectarAnomalias } = require('./deteccion');
const { generarInsight } = require('./insights');
const pool = require('./db');

async function analizarNegocio(usuarioId) {
  try {
    const result = await pool.query(
      'SELECT * FROM transacciones WHERE usuario_id = $1 ORDER BY fecha ASC',
      [usuarioId]
    );
    const transacciones = result.rows;
    if (transacciones.length === 0) {
      return { alertas: [], mensaje: 'Sin transacciones para analizar' };
    }
    const anomalias = detectarAnomalias(transacciones);
    const alertas = anomalias.map(a => ({
      ...a,
      insight: generarInsight(a)
    }));
    const criticas = alertas.filter(a => a.confianza.nivel === 'ALTA');
    const medias = alertas.filter(a => a.confianza.nivel === 'MEDIA');
    const bajas = alertas.filter(a => a.confianza.nivel === 'BAJA');
    return {
      total_transacciones: transacciones.length,
      total_alertas: alertas.length,
      criticas: criticas.length,
      medias: medias.length,
      bajas: bajas.length,
      alertas: alertas.slice(0, 20)
    };
  } catch(e) {
    console.error(e);
    return { error: e.message };
  }
}

module.exports = { analizarNegocio };