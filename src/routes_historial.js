const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { auth } = require('./authMiddleware');

const TZ = 'America/Argentina/Buenos_Aires';

const DIAS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const TURNOS_LABEL = { MANANA: 'Mañana', TARDE: 'Tarde', NOCHE: 'Noche', SIN_TURNO: 'Sin turno' };

function calcTendencia(actual, anterior) {
  if (!anterior || anterior === 0) return 'estable';
  const diff = (actual - anterior) / anterior;
  if (diff > 0.02) return 'subiendo';
  if (diff < -0.02) return 'bajando';
  return 'estable';
}

function buildResult(actual, anterior, extras = {}) {
  const a = Math.round(actual);
  const p = Math.round(anterior);
  return {
    valor_actual: a,
    valor_anterior: p,
    diferencia_pesos: a - p,
    diferencia_porcentaje: p > 0 ? Math.round(((a - p) / p) * 100) : 0,
    tendencia: calcTendencia(actual, anterior),
    ...extras,
  };
}

function getSid(req) {
  return req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;
}

// ─── GET /api/historial/hoy-vs-semana ────────────────────────────────────────
// Ventas de hoy vs mismo día de la semana pasada

router.get('/hoy-vs-semana', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COALESCE(SUM(CASE
          WHEN (fecha AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date
          THEN monto END), 0) AS hoy,
        COALESCE(SUM(CASE
          WHEN (fecha AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date - 7
          THEN monto END), 0) AS semana_pasada
      FROM transacciones
      WHERE usuario_id = $1
        AND ($2::integer IS NULL OR sucursal_id = $2)
        AND monto > 0
    `, [req.user.id, getSid(req)]);

    const { hoy, semana_pasada } = r.rows[0];
    res.json(buildResult(parseFloat(hoy), parseFloat(semana_pasada)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/historial/semana-vs-semana ──────────────────────────────────────
// Esta semana (lun→hoy) vs el mismo tramo de la semana anterior

router.get('/semana-vs-semana', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      WITH bounds AS (
        SELECT
          DATE_TRUNC('week', (NOW() AT TIME ZONE '${TZ}')::date::timestamp)::date AS lunes_esta,
          (DATE_TRUNC('week', (NOW() AT TIME ZONE '${TZ}')::date::timestamp) - INTERVAL '7 days')::date AS lunes_anterior,
          (NOW() AT TIME ZONE '${TZ}')::date AS hoy
      )
      SELECT
        COALESCE(SUM(CASE
          WHEN (fecha AT TIME ZONE '${TZ}')::date BETWEEN b.lunes_esta AND b.hoy
          THEN monto END), 0) AS esta_semana,
        COALESCE(SUM(CASE
          WHEN (fecha AT TIME ZONE '${TZ}')::date BETWEEN b.lunes_anterior
               AND b.lunes_anterior + (b.hoy - b.lunes_esta)
          THEN monto END), 0) AS semana_anterior
      FROM transacciones, bounds b
      WHERE usuario_id = $1
        AND ($2::integer IS NULL OR sucursal_id = $2)
        AND monto > 0
    `, [req.user.id, getSid(req)]);

    const { esta_semana, semana_anterior } = r.rows[0];
    res.json(buildResult(parseFloat(esta_semana), parseFloat(semana_anterior)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/historial/mes-vs-mes ────────────────────────────────────────────
// Este mes (día 1→hoy) vs mismo tramo del mes anterior

router.get('/mes-vs-mes', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      WITH bounds AS (
        SELECT
          DATE_TRUNC('month', (NOW() AT TIME ZONE '${TZ}')::date::timestamp)::date AS primer_este,
          (DATE_TRUNC('month', (NOW() AT TIME ZONE '${TZ}')::date::timestamp) - INTERVAL '1 month')::date AS primer_anterior,
          (NOW() AT TIME ZONE '${TZ}')::date AS hoy
      )
      SELECT
        COALESCE(SUM(CASE
          WHEN (fecha AT TIME ZONE '${TZ}')::date BETWEEN b.primer_este AND b.hoy
          THEN monto END), 0) AS este_mes,
        COALESCE(SUM(CASE
          WHEN (fecha AT TIME ZONE '${TZ}')::date BETWEEN b.primer_anterior
               AND b.primer_anterior + (b.hoy - b.primer_este)
          THEN monto END), 0) AS mes_anterior
      FROM transacciones, bounds b
      WHERE usuario_id = $1
        AND ($2::integer IS NULL OR sucursal_id = $2)
        AND monto > 0
    `, [req.user.id, getSid(req)]);

    const { este_mes, mes_anterior } = r.rows[0];
    res.json(buildResult(parseFloat(este_mes), parseFloat(mes_anterior)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/historial/mejor-dia ────────────────────────────────────────────
// Día de la semana con mayor promedio de ventas histórico

router.get('/mejor-dia', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        EXTRACT(DOW FROM (fecha AT TIME ZONE '${TZ}')::date)::int AS dia_num,
        AVG(ventas_dia) AS promedio,
        COUNT(*) AS n_dias
      FROM (
        SELECT
          (fecha AT TIME ZONE '${TZ}')::date AS f,
          EXTRACT(DOW FROM (fecha AT TIME ZONE '${TZ}')::date)::int AS dia_num,
          SUM(monto) AS ventas_dia
        FROM transacciones
        WHERE usuario_id = $1
          AND ($2::integer IS NULL OR sucursal_id = $2)
          AND monto > 0
        GROUP BY f, dia_num
      ) diarios
      GROUP BY dia_num
      ORDER BY promedio DESC
    `, [req.user.id, getSid(req)]);

    if (r.rows.length === 0) return res.json({ disponible: false, motivo: 'sin_datos' });

    const dias = r.rows.map(row => ({
      dia: DIAS_ES[row.dia_num],
      dia_num: row.dia_num,
      promedio_ventas: Math.round(parseFloat(row.promedio)),
      n_dias: parseInt(row.n_dias),
    }));

    const mejor = dias[0];
    const promedioGeneral = dias.reduce((s, d) => s + d.promedio_ventas, 0) / dias.length;

    res.json(buildResult(mejor.promedio_ventas, promedioGeneral, {
      mejor_dia: mejor.dia,
      dias,
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/historial/mejor-turno ──────────────────────────────────────────
// Turno con mayor promedio de ventas histórico

router.get('/mejor-turno', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COALESCE(turno, 'SIN_TURNO') AS turno,
        AVG(ventas_turno) AS promedio,
        COUNT(*) AS n_dias
      FROM (
        SELECT
          (fecha AT TIME ZONE '${TZ}')::date AS f,
          COALESCE(turno, 'SIN_TURNO') AS turno,
          SUM(monto) AS ventas_turno
        FROM transacciones
        WHERE usuario_id = $1
          AND ($2::integer IS NULL OR sucursal_id = $2)
          AND monto > 0
          AND turno IS NOT NULL
        GROUP BY f, turno
      ) diarios
      GROUP BY turno
      ORDER BY promedio DESC
    `, [req.user.id, getSid(req)]);

    if (r.rows.length === 0) return res.json({ disponible: false, motivo: 'sin_datos' });

    const turnos = r.rows.map(row => ({
      turno: TURNOS_LABEL[row.turno] || row.turno,
      turno_key: row.turno,
      promedio_ventas: Math.round(parseFloat(row.promedio)),
      n_dias: parseInt(row.n_dias),
    }));

    const mejor = turnos[0];
    const promedioGeneral = turnos.reduce((s, t) => s + t.promedio_ventas, 0) / turnos.length;

    res.json(buildResult(mejor.promedio_ventas, promedioGeneral, {
      mejor_turno: mejor.turno,
      turnos,
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/historial/ticket-30dias ─────────────────────────────────────────
// Evolución del ticket promedio día a día — últimos 30 días
// Comparación: últimos 7 días vs los 7 días anteriores

router.get('/ticket-30dias', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        (fecha AT TIME ZONE '${TZ}')::date AS fecha,
        ROUND(AVG(monto)::numeric, 0) AS ticket_promedio,
        COUNT(*) AS n_transacciones
      FROM transacciones
      WHERE usuario_id = $1
        AND ($2::integer IS NULL OR sucursal_id = $2)
        AND monto > 0
        AND fecha >= NOW() - INTERVAL '30 days'
      GROUP BY (fecha AT TIME ZONE '${TZ}')::date
      ORDER BY fecha ASC
    `, [req.user.id, getSid(req)]);

    const dias = r.rows.map(d => ({
      fecha: d.fecha,
      ticket_promedio: Math.round(parseFloat(d.ticket_promedio)),
      n_transacciones: parseInt(d.n_transacciones),
    }));

    if (dias.length === 0) return res.json({ disponible: false, motivo: 'sin_datos', dias: [] });

    // Últimos 7 días vs los 7 anteriores para la comparación de tendencia
    const ahora = Date.now();
    const ms7d = 7 * 86400000;
    const recientes  = dias.filter(d => ahora - new Date(d.fecha + 'T12:00:00').getTime() <= ms7d);
    const anteriores = dias.filter(d => {
      const t = ahora - new Date(d.fecha + 'T12:00:00').getTime();
      return t > ms7d && t <= ms7d * 2;
    });

    const avgR = recientes.length  ? recientes.reduce((s, d) => s + d.ticket_promedio, 0) / recientes.length  : 0;
    const avgA = anteriores.length ? anteriores.reduce((s, d) => s + d.ticket_promedio, 0) / anteriores.length : avgR;

    res.json(buildResult(avgR, avgA, { dias }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
