// routes_stock.js — stock liviano del dueño: ver, contar, poner mínimo, historial.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const stock = require('./stock');

// GET /api/stock — todos los productos con su estado + resumen
router.get('/', auth, async (req, res) => {
  try { await stock.asegurar(); res.json(await stock.listar(req.user.negocio_id)); }
  catch (e) { console.error('stock/listar:', e.message); res.status(500).json({ error: 'No pude cargar el stock.' }); }
});

// POST /api/stock/contar  { items: [{ producto_id, contado }] }  — stock inicial o conteo con ajuste
router.post('/contar', auth, async (req, res) => {
  try {
    await stock.asegurar();
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 500) : [];
    if (!items.length) return res.status(400).json({ error: 'No hay nada para guardar.' });
    const quien = (req.user && (req.user.nombre || req.user.email)) || null;
    res.json(await stock.contar(req.user.negocio_id, items, quien));
  } catch (e) { console.error('stock/contar:', e.message); res.status(500).json({ error: 'No pude guardar el conteo.' }); }
});

// POST /api/stock/minimo  { producto_id, minimo }  — minimo vacío o null lo saca
router.post('/minimo', auth, async (req, res) => {
  try {
    await stock.asegurar();
    const pid = parseInt(req.body && req.body.producto_id, 10);
    if (!pid) return res.status(400).json({ error: 'Falta el producto.' });
    const raw = req.body.minimo;
    const m = raw === '' || raw == null ? null : Number(raw);
    if (m != null && (!Number.isFinite(m) || m < 0 || m > 1e7)) return res.status(400).json({ error: 'Mínimo inválido.' });
    const r = await pool.query('UPDATE productos SET stock_minimo = $3 WHERE id = $1 AND negocio_id = $2 RETURNING id', [pid, req.user.negocio_id, m]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado.' });
    res.json({ ok: true });
  } catch (e) { console.error('stock/minimo:', e.message); res.status(500).json({ error: 'No pude guardar.' }); }
});

// POST /api/stock/dejar-de-controlar { producto_id } — vuelve a "sin control"
router.post('/dejar-de-controlar', auth, async (req, res) => {
  try {
    await stock.asegurar();
    const pid = parseInt(req.body && req.body.producto_id, 10);
    if (!pid) return res.status(400).json({ error: 'Falta el producto.' });
    await pool.query('UPDATE productos SET stock = NULL, stock_minimo = NULL WHERE id = $1 AND negocio_id = $2', [pid, req.user.negocio_id]);
    res.json({ ok: true });
  } catch (e) { console.error('stock/dejar:', e.message); res.status(500).json({ error: 'No pude guardar.' }); }
});

// GET /api/stock/movimientos?producto_id=  — historial de un producto (o los últimos del negocio)
router.get('/movimientos', auth, async (req, res) => {
  try {
    await stock.asegurar();
    const pid = parseInt(req.query.producto_id, 10) || null;
    const r = await pool.query(
      `SELECT m.id, m.producto_id, p.nombre, m.tipo, m.cantidad::float AS cantidad, m.stock_despues::float AS stock_despues, m.creado
         FROM movimientos_stock m JOIN productos p ON p.id = m.producto_id
        WHERE m.negocio_id = $1 AND ($2::int IS NULL OR m.producto_id = $2) ORDER BY m.creado DESC, m.id DESC LIMIT 60`, [req.user.negocio_id, pid]);
    res.json({ movimientos: r.rows });
  } catch (e) { console.error('stock/movimientos:', e.message); res.status(500).json({ error: 'No pude cargar el historial.' }); }
});

module.exports = router;
