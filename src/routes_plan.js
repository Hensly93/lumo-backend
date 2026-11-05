// routes_plan.js — Abono de LumoBi (parte 1: solo calcula el precio, no cobra).
//
//   POST /api/plan/calcular  (publica, no usa datos de nadie) body: { cajas: [3, 2], empleados: 8 }
//                            "cajas" es una lista con las cajas de cada local.
//   GET  /api/plan/mio       (con login) plan y precio del negocio, calculado con sus datos reales

const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { calcularPrecio, efectivo } = require('./precios');

// Asegura las columnas del tamano declarado al registrarse.
pool
  .query('ALTER TABLE negocios ADD COLUMN IF NOT EXISTS locales_declarados integer, ADD COLUMN IF NOT EXISTS cajas_declaradas integer, ADD COLUMN IF NOT EXISTS empleados_declarados integer')
  .catch((e) => console.error('plan: no se pudieron asegurar las columnas de tamano declarado:', e.message));

// Asegura la columna "cajas" en cada local (cada local trae 1 por defecto).
pool
  .query('ALTER TABLE mis_sucursales ADD COLUMN IF NOT EXISTS cajas integer NOT NULL DEFAULT 1')
  .catch((e) => console.error('plan: no se pudo asegurar la columna cajas:', e.message));

// ─── POST /api/plan/calcular ─────────────────────────────────────────────────
router.post('/calcular', (req, res) => {
  const cajas = req.body && req.body.cajas;
  const empleados = req.body ? Number(req.body.empleados) : NaN;
  if (!Array.isArray(cajas) || cajas.length < 1 || cajas.length > 50) {
    return res.status(400).json({ error: 'cajas tiene que ser una lista con una cantidad de cajas por local (de 1 a 50 locales).' });
  }
  if (!cajas.every((c) => Number.isInteger(c) && c >= 1 && c <= 100)) {
    return res.status(400).json({ error: 'Cada local tiene que tener entre 1 y 100 cajas.' });
  }
  if (!Number.isInteger(empleados) || empleados < 0 || empleados > 1000) {
    return res.status(400).json({ error: 'empleados tiene que ser un numero entero entre 0 y 1000.' });
  }
  res.json(calcularPrecio(cajas, empleados));
});

// ─── PATCH /api/plan/tamano ──────────────────────────────────────────────────
// body: { locales, cajas (por local), empleados }. Guarda lo que el negocio declara y devuelve el precio.
router.patch('/tamano', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const l = Number(b.locales);
    const c = Number(b.cajas);
    const e = Number(b.empleados);
    if (!Number.isInteger(l) || l < 1 || l > 50) return res.status(400).json({ error: 'Los locales tienen que ser un numero entero entre 1 y 50.' });
    if (!Number.isInteger(c) || c < 1 || c > 100) return res.status(400).json({ error: 'Las cajas por local tienen que ser un numero entero entre 1 y 100.' });
    if (!Number.isInteger(e) || e < 0 || e > 1000) return res.status(400).json({ error: 'Los empleados tienen que ser un numero entero entre 0 y 1000.' });
    await pool.query(
      'UPDATE negocios SET locales_declarados=$1, cajas_declaradas=$2, empleados_declarados=$3, updated_at=NOW() WHERE id=$4',
      [l, c, e, req.user.negocio_id]
    );
    const cajasPorLocal = [];
    for (let i = 0; i < l; i++) cajasPorLocal.push(c);
    res.json(calcularPrecio(cajasPorLocal, e));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/plan/mio ───────────────────────────────────────────────────────
router.get('/mio', auth, async (req, res) => {
  try {
    const negocioId = req.user.negocio_id;
    const suc = await pool.query(
      'SELECT cajas FROM mis_sucursales WHERE negocio_id=$1 AND activo=true ORDER BY id',
      [negocioId]
    );
    const emp = await pool.query(
      'SELECT COUNT(*)::int AS n FROM empleados_negocio WHERE negocio_id=$1 AND activo=true',
      [negocioId]
    );
    const neg = await pool.query(
      'SELECT plan_id, subscription_status, subscription_end_date, locales_declarados, cajas_declaradas, empleados_declarados FROM negocios WHERE id=$1',
      [negocioId]
    );
    const n = neg.rows[0] || {};
    const ef = efectivo(suc.rows.map((r) => r.cajas), emp.rows[0].n, {
      locales: n.locales_declarados,
      cajas: n.cajas_declaradas,
      empleados: n.empleados_declarados,
    });
    const calculo = calcularPrecio(ef.cajas, ef.empleados);
    res.json(
      Object.assign({}, calculo, {
        suscripcion: {
          plan_id: n.plan_id || null,
          estado: n.subscription_status || null,
          fin: n.subscription_end_date || null,
        },
      })
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
