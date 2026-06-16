const express = require('express');
const router = express.Router();
const pool = require('./db');
const jwt = require('jsonwebtoken');

// Middleware de autenticación
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

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
    const usuarioId = req.user.id;

    // Obtener todas las transacciones del usuario
    const result = await pool.query(
      `SELECT fecha, monto, metodo_pago, turno
       FROM transacciones
       WHERE usuario_id = $1
       ORDER BY fecha DESC`,
      [usuarioId]
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

    res.json({
      score: dq.score,
      total_transacciones: transacciones.length,
      daysCount: diasHistorial,
      message: mensaje,
      status: status,
      detalle: dq.detalle
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
