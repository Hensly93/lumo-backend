const express = require('express');
const router = express.Router();
const pool = require('./db');
const jwt = require('jsonwebtoken');
const { auth } = require('./authMiddleware');

function calcularDataQualityScore(transacciones) {
  if (!transacciones || transacciones.length === 0) {
    return { score: 0, detalle: { volumen: 0, historial: 0, cobertura: 0, completitud: 0 } };
  }

  const n = transacciones.length;
  const fechas = transacciones.map(t => new Date(t.fecha).getTime());
  const diasHistorial = (Math.max(...fechas) - Math.min(...fechas)) / (1000 * 60 * 60 * 24);
  const turnos = new Set(transacciones.map(t => t.turno).filter(Boolean));
  const conMetodo = transacciones.filter(t => t.metodo_pago).length;

  const volumen     = Math.min(n / 200, 1.0);
  const historial   = Math.min(diasHistorial / 30, 1.0);
  const cobertura   = Math.min(turnos.size / 3, 1.0);
  const completitud = conMetodo / n;

  const score = Math.round((volumen * 0.4 + historial * 0.3 + cobertura * 0.2 + completitud * 0.1) * 100);

  return {
    score,
    detalle: {
      volumen:     Math.round(volumen * 100),
      historial:   Math.round(historial * 100),
      cobertura:   Math.round(cobertura * 100),
      completitud: Math.round(completitud * 100),
    }
  };
}

function determinarMensajeContextual(score, nTransacciones, diasHistorial) {
  if (score >= 90) {
    return "Datos completos y confiables. Motor funcionando a capacidad máxima.";
  } else if (score >= 70) {
    const faltantesVolumen = Math.max(0, 200 - nTransacciones);
    const faltantesDias = Math.max(0, 30 - diasHistorial);
    if (faltantesVolumen > 0) {
      return `Necesitás ${faltantesVolumen}+ transacciones para datos óptimos.`;
    }
    if (faltantesDias > 0) {
      return `Necesitás ${Math.ceil(faltantesDias)}+ días de historial para calibración completa.`;
    }
    return "Seguí registrando para mejorar la precisión del motor.";
  } else if (score >= 40) {
    const faltantesVolumen = Math.max(0, 200 - nTransacciones);
    return `Datos insuficientes. Faltán ${faltantesVolumen}+ transacciones. Las predicciones serán aproximadas.`;
  } else {
    return "Datos muy limitados. NICOLE necesita más historial para funcionar correctamente.";
  }
}

// GET /api/negocio/data-quality-score
router.get('/data-quality-score', auth, async (req, res) => {
  try {
    // Transacciones del negocio (antes buscaba por usuario_id y las ventas de la caja no lo tienen: daba siempre 0)
    const result = await pool.query(
      `SELECT fecha, monto, metodo_pago, turno
       FROM transacciones
       WHERE negocio_id = $1 AND COALESCE(tipo,'venta') <> 'anulacion'
       ORDER BY fecha DESC`,
      [req.user.negocio_id]
    );

    const transacciones = result.rows;

    if (transacciones.length === 0) {
      return res.json({
        score: 0,
        total_transacciones: 0,
        daysCount: 0,
        message: "Sin transacciones aún. Comenzá a registrar ventas para que el motor de detección funcione.",
        status: "critical"
      });
    }

    // Calcular data quality score
    const dq = calcularDataQualityScore(transacciones);

    // Calcular días de historial
    const fechas = transacciones.map(t => new Date(t.fecha).getTime());
    const diasHistorial = Math.ceil((Math.max(...fechas) - Math.min(...fechas)) / (1000 * 60 * 60 * 24)) || 1;

    // Determinar mensaje contextual
    const mensaje = determinarMensajeContextual(dq.score, transacciones.length, diasHistorial);

    // Determinar status
    let status = "critical";
    if (dq.score >= 90) status = "good";
    else if (dq.score >= 70) status = "warning";

    // Qué tan completo está el costo de lo que se vende (de eso depende la ganancia real) y el catálogo
    let costo = null;
    try {
      const c = await pool.query(
        `SELECT COALESCE(SUM(d.subtotal) FILTER (WHERE d.costo_unitario > 0),0)::float AS con_costo, COALESCE(SUM(d.subtotal),0)::float AS total
           FROM transacciones t JOIN transacciones_detalle d ON d.transaccion_id = t.id
          WHERE t.negocio_id = $1 AND COALESCE(d.tipo_linea,'producto') = 'producto' AND t.fecha >= NOW() - INTERVAL '30 days'`, [req.user.negocio_id]);
      const p = await pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE COALESCE(precio_costo,0) <= 0)::int AS sin_costo
           FROM productos WHERE negocio_id = $1 AND activo = true`, [req.user.negocio_id]);
      const x = c.rows[0], y = p.rows[0];
      costo = {
        ventas_con_costo_pct: x.total > 0 ? Math.round((x.con_costo / x.total) * 100) : null,
        productos: y.total, productos_sin_costo: y.sin_costo,
      };
    } catch (e) { console.error('data-quality/costo:', e.message); }

    // Qué falta, en cristiano: cada punto afecta un número concreto de la app
    const faltan = [];
    if (costo && costo.productos_sin_costo > 0) {
      faltan.push(`${costo.productos_sin_costo} de tus ${costo.productos} productos no tienen costo cargado: la ganancia por producto y la ganancia real del mes se calculan con menos datos.`);
    }
    if (dq.detalle.completitud < 90) faltan.push(`El ${100 - dq.detalle.completitud}% de las ventas no tiene medio de pago: el cálculo de comisiones queda incompleto.`);
    if (dq.detalle.historial < 100) faltan.push(`Hay ${diasHistorial} días de historial; las comparaciones por día y por hora mejoran con 30.`);
    if (dq.detalle.volumen < 100) faltan.push(`Hay ${transacciones.length} ventas; con 200 los promedios son estables.`);

    res.json({
      score: dq.score,
      total_transacciones: transacciones.length,
      daysCount: diasHistorial,
      message: mensaje,
      status: status,
      detalle: dq.detalle,
      costo,
      faltan
    });
  } catch (e) {
    console.error("Error en data-quality-score:", e);
    // En lugar de devolver 500, devolver JSON por defecto
    res.json({
      score: 0,
      total_transacciones: 0,
      daysCount: 0,
      message: "Sin datos suficientes",
      status: "critical"
    });
  }
});

module.exports = router;
