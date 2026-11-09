// routes_plan_estado.js — Estado del plan y vista resumida (funcionan aunque el plan este vencido).
//   GET /api/plan/estado   -> { estado: 'trial'|'activa'|'vencida', dias_restantes, trial_fin, sin_vencimiento }
//   GET /api/plan/resumen  -> resumen del ultimo mes: ventas y plata en fuga (sin el detalle: eso es del plan activo)

const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { estadoPlan } = require('./plan_gate');

router.get('/estado', auth, async (req, res) => {
  try {
    res.json(await estadoPlan(pool, req.user.negocio_id));
  } catch (e) {
    console.error('[PLAN] estado:', e.message);
    res.status(500).json({ error: 'No se pudo leer el plan' });
  }
});

router.get('/resumen', auth, async (req, res) => {
  try {
    const nid = req.user.negocio_id;
    const v = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(monto), 0)::float AS total
       FROM transacciones
       WHERE negocio_id = $1 AND COALESCE(origin,'real') IN ('real','importado')
         AND fecha >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days'`, [nid]);
    const n = v.rows[0].n, total = Math.round(v.rows[0].total);
    let fugas = null;
    try {
      const f = await require('./fugas').calcularFugas(nid);
      if (f && f.resumen) fugas = { cantidad: f.resumen.cantidad || 0, monto: Math.round(f.resumen.en_fuga || 0) };
    } catch (e) { console.error('[PLAN] resumen fugas:', e.message); }
    res.json({
      periodo: 'últimos 30 días',
      ventas: { total, cantidad: n, ticket_promedio: n ? Math.round(total / n) : 0 },
      fugas,
      bloqueado: [
        'Dónde está cada fuga y cómo cerrarla',
        'Proyecciones y recomendaciones',
        'Caja, equipo y rentabilidad',
      ],
    });
  } catch (e) {
    console.error('[PLAN] resumen:', e.message);
    res.status(500).json({ error: 'No se pudo armar el resumen' });
  }
});

module.exports = router;
