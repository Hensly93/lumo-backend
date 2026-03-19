const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { analizarNegocio } = require('./motor');
const pool = require('./db');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Token invalido' });
  }
}

router.get('/analisis', authMiddleware, async (req, res) => {
  const resultado = await analizarNegocio(req.user.id);
  res.json(resultado);
});

router.post('/transacciones', authMiddleware, async (req, res) => {
  try {
    const { monto, tipo, empleado, turno, fecha } = req.body;
    const result = await pool.query(
      'INSERT INTO transacciones(usuario_id, monto, tipo, empleado, turno, fecha) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, monto, tipo, empleado, turno, fecha || new Date()]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;