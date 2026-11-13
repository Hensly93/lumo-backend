// routes_autorizaciones.js — autorizaciones de la caja (ver autorizacion_caja.js)
//   Caja (token del turno):  GET /estado/:id · POST /:id/pin · POST /:id/cancelar
//   Dueño (login):           GET / · POST /pin · POST /:id/resolver
const express = require('express');
const router = express.Router();
const { auth } = require('./authMiddleware');
const { authTurno } = require('./sesion_empleado');
const A = require('./autorizacion_caja');
const json = express.json({ limit: '2kb' });
const idDe = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };

// ── Caja ──
router.get('/estado/:id', authTurno, async (req, res) => {
  try {
    const id = idDe(req.params.id);
    const a = id && await A.leer(id, { turno_id: req.turno.id });
    if (!a) return res.status(404).json({ error: 'No encontramos el pedido' });
    res.json({ estado: a.estado, metodo: a.metodo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/pin', authTurno, json, async (req, res) => {
  try {
    const id = idDe(req.params.id);
    if (!id) return res.status(400).json({ error: 'Pedido inválido' });
    const r = await A.aprobarConPin(id, req.turno.id, req.body && req.body.pin);
    if (!r.ok) return res.status(400).json({ error: r.error, restantes: r.restantes });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/cancelar', authTurno, async (req, res) => {
  try {
    const id = idDe(req.params.id);
    if (id) await A.cancelar(id, req.turno.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dueño ──
router.get('/', auth, async (req, res) => {
  try {
    const [autorizaciones, pin] = await Promise.all([A.listar(req.user.negocio_id), A.hayPin(req.user.id)]);
    res.json({ autorizaciones, pin_configurado: pin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pin', auth, json, async (req, res) => {
  try {
    await A.fijarPin(req.user.id, req.body && req.body.pin);
    res.json({ ok: true });
  } catch (e) { res.status(e.codigo || 500).json({ error: e.message }); }
});

router.post('/:id/resolver', auth, json, async (req, res) => {
  try {
    const id = idDe(req.params.id);
    const d = req.body && req.body.decision;
    if (!id || !['aprobar', 'rechazar'].includes(d)) return res.status(400).json({ error: 'Pedido inválido' });
    const r = await A.resolverDueno(id, req.user.negocio_id, d);
    if (!r.ok) return res.status(r.codigo || 400).json({ error: r.error });
    res.json({ ok: true, estado: r.estado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
