// routes_hallazgos.js — lo que LumoBi detectó en el negocio y el feedback del dueño. Ver hallazgos.js
const express = require('express');
const router = express.Router();
const { auth } = require('./authMiddleware');
const hallazgos = require('./hallazgos');

// GET /api/hallazgos — hallazgos vigentes (con plata y evidencia) y si pasan el filtro de calidad
router.get('/', auth, async (req, res) => {
  try {
    const lista = await hallazgos.obtener(req.user.negocio_id);
    res.json({
      hallazgos: lista.map((h) => ({
        id: h.id, clave: h.clave, titulo: h.titulo, detalle: h.detalle, evidencia: h.evidencia, monto: h.monto, monto_texto: h.monto_texto,
        tipo: h.tipo, url: h.url, positivo: h.positivo, estado: h.estado, veces: h.veces, importante: h.puerta.pasa, motivo: h.puerta.motivo,
      })),
    });
  } catch (e) {
    console.error('hallazgos/listar:', e.message);
    res.status(500).json({ error: 'No pude cargar los hallazgos.' });
  }
});

// POST /api/hallazgos/:id/feedback  { accion: 'util' | 'no_sirve' | 'ya_lo_sabia' | 'resuelto' }
router.post('/:id/feedback', auth, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'No encontrado' });
    const r = await hallazgos.registrarFeedback(req.user.negocio_id, Number(req.params.id), String((req.body || {}).accion || ''));
    res.json({ ok: true, ...r });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('hallazgos/feedback:', e.message);
    res.status(500).json({ error: 'No pude guardar tu respuesta.' });
  }
});

module.exports = router;
