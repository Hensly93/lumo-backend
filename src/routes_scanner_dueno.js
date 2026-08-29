const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');

// POST /api/scanner-dueno/sesion — crea el pareo QR para el dueño
router.post('/sesion', auth, async (req, res) => {
  try {
    const expira = new Date();
    expira.setHours(expira.getHours() + 8);
    const result = await pool.query(
      `INSERT INTO sesiones_scanner_dueno (negocio_id, usuario_id, expira_en)
       VALUES ($1, $2, $3)
       RETURNING token, expira_en`,
      [req.user.negocio_id, req.user.id, expira]
    );
    res.json({ token: result.rows[0].token, expira_en: result.rows[0].expira_en });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scanner-dueno/sesion/:token — valida sesión, público (lo llama el celu)
router.get('/sesion/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(token)) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    const sesion = await pool.query(
      `SELECT * FROM sesiones_scanner_dueno WHERE token=$1 AND expira_en > NOW()`,
      [token]
    );
    if (sesion.rows.length === 0) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    res.json({ valida: true, negocio_id: sesion.rows[0].negocio_id });
  } catch (e) {
    if (e.code === '22P02') {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scanner-dueno/:token/codigo — el celu manda un código escaneado
router.post('/:token/codigo', async (req, res) => {
  try {
    const { token } = req.params;
    const { codigo_barras } = req.body;
    if (!codigo_barras) return res.status(400).json({ error: 'codigo_barras requerido' });
    const sesion = await pool.query(
      `SELECT negocio_id FROM sesiones_scanner_dueno WHERE token=$1 AND expira_en > NOW()`,
      [token]
    );
    if (sesion.rows.length === 0) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    const negocio_id = sesion.rows[0].negocio_id;
    const existe = await pool.query(
      'SELECT id FROM productos WHERE negocio_id=$1 AND codigo_barras=$2',
      [negocio_id, codigo_barras]
    );
    if (existe.rows.length > 0) {
      return res.json({ ya_existe: true });
    }
    await pool.query(
      'INSERT INTO codigos_pendientes_dueno (negocio_id, codigo_barras) VALUES ($1, $2)',
      [negocio_id, codigo_barras]
    );
    res.json({ agregado: true, codigo_barras });
  } catch (e) {
    if (e.code === '22P02') {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scanner-dueno/pendientes — lista para que el dueño complete precio/nombre
router.get('/pendientes', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM codigos_pendientes_dueno WHERE negocio_id=$1 ORDER BY creado_en DESC',
      [req.user.negocio_id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/scanner-dueno/pendientes/:id — sacar de la cola una vez cargado
router.delete('/pendientes/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM codigos_pendientes_dueno WHERE id=$1 AND negocio_id=$2 RETURNING *',
      [req.params.id, req.user.negocio_id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ eliminado: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
