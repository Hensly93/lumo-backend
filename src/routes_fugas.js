// routes_fugas.js — Fugas de plata.
//   GET  /api/fugas             (con login) fugas del negocio: donde, cuanto, evidencia, como corregir, estado
//   POST /api/fugas/estado      (con login, solo el dueño) body { id, estado, nota, monto }
//                               estado: en_seguimiento | resuelta | descartada | activa

const express = require('express');
const router = express.Router();
const { auth } = require('./authMiddleware');
const { calcularFugas, marcarFuga } = require('./fugas');

router.get('/', auth, async (req, res) => {
  try {
    res.json(await calcularFugas(req.user.negocio_id));
  } catch (e) {
    console.error('[FUGAS] error:', e.message);
    res.status(500).json({ error: 'No se pudieron calcular las fugas' });
  }
});

// GET /api/fugas/anulaciones?dias=30 — anulaciones por motivo y por persona
router.get('/anulaciones', auth, async (req, res) => {
  try { res.json(await require('./anular_venta').anulacionesPorMotivo(req.user.negocio_id, req.query.dias)); }
  catch (e) { console.error('[FUGAS] anulaciones:', e.message); res.status(500).json({ error: 'No pude armar las anulaciones' }); }
});

router.post('/estado', auth, async (req, res) => {
  try {
    if (req.user.rol && req.user.rol !== 'owner') return res.status(403).json({ error: 'Solo el dueño puede cambiar el estado de una fuga' });
    const b = req.body || {};
    if (!b.id || typeof b.id !== 'string') return res.status(400).json({ error: 'Falta el id de la fuga' });
    await marcarFuga(req.user.negocio_id, b.id, b.estado, b.nota, b.monto);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
