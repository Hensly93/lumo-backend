// routes_multilocal.js — Lumo S8 (Bug Red)
// El dueño agrega sus propios locales con nombre y dirección.
// No hay invitaciones a otros negocios.
// KPIs por local disponibles cuando transacciones/turnos llevan sucursal_id.

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
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

// ─── POST /api/multilocal/sucursal ───────────────────────────────────────────
// Agregar un local propio (nombre + dirección)
router.post('/sucursal', authMiddleware, async (req, res) => {
  try {
    const { nombre, direccion } = req.body;
    if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
    const result = await pool.query(
      `INSERT INTO mis_sucursales(usuario_id, nombre, direccion)
       VALUES($1,$2,$3) RETURNING *`,
      [req.user.id, nombre.trim(), direccion?.trim() || null]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/multilocal/red ─────────────────────────────────────────────────
// Dashboard: lista de locales propios con KPIs
router.get('/red', authMiddleware, async (req, res) => {
  try {
    const sucursales = await pool.query(
      `SELECT id, nombre, direccion, activo, created_at
       FROM mis_sucursales
       WHERE usuario_id=$1 AND activo=true
       ORDER BY nombre ASC`,
      [req.user.id]
    );

    if (sucursales.rows.length === 0) {
      return res.json({ sucursales: [], resumen: null });
    }

    const kpis = await Promise.all(
      sucursales.rows.map(async (s) => {
        const [ventas, brechas, turnoActivo] = await Promise.all([
          pool.query(
            `SELECT COALESCE(SUM(monto),0) as total, COUNT(*) as tx
             FROM transacciones
             WHERE usuario_id=$1 AND sucursal_id=$2
               AND DATE_TRUNC('month', fecha) = DATE_TRUNC('month', NOW())`,
            [req.user.id, s.id]
          ),
          pool.query(
            `SELECT COALESCE(AVG(ABS(brecha)),0) as brecha_prom, COUNT(*) as n_turnos
             FROM turnos_caja
             WHERE usuario_id=$1 AND sucursal_id=$2 AND estado='cerrado'
               AND hora_apertura >= NOW() - INTERVAL '30 days'`,
            [req.user.id, s.id]
          ),
          pool.query(
            `SELECT nombre_empleado, tipo_turno, hora_apertura
             FROM turnos_caja
             WHERE usuario_id=$1 AND sucursal_id=$2 AND estado='activo'
             ORDER BY hora_apertura DESC LIMIT 1`,
            [req.user.id, s.id]
          ),
        ]);

        const brechaVal = parseFloat(brechas.rows[0].brecha_prom);
        const txMes = parseInt(ventas.rows[0].tx);
        const semaforo = txMes === 0 ? 'sin_datos' : brechaVal > 2000 ? 'rojo' : brechaVal > 500 ? 'amarillo' : 'verde';

        return {
          id: s.id,
          nombre: s.nombre,
          direccion: s.direccion,
          ventas_mes: parseFloat(ventas.rows[0].total),
          tx_mes: txMes,
          brecha_promedio: Math.round(brechaVal),
          n_turnos_analizados: parseInt(brechas.rows[0].n_turnos),
          turno_activo: turnoActivo.rows[0] || null,
          semaforo,
          sin_datos: txMes === 0,
        };
      })
    );

    const totalVentas = kpis.reduce((a, b) => a + b.ventas_mes, 0);
    const sucursalesRojo = kpis.filter(k => k.semaforo === 'rojo').length;
    const sucursalesMasVentas = [...kpis].sort((a, b) => b.ventas_mes - a.ventas_mes)[0];

    res.json({
      sucursales: kpis,
      resumen: {
        total_sucursales: kpis.length,
        ventas_red_mes: Math.round(totalVentas),
        sucursales_en_rojo: sucursalesRojo,
        local_mas_ventas: sucursalesMasVentas?.ventas_mes > 0 ? sucursalesMasVentas.nombre : null,
      },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/multilocal/sucursal/:id ──────────────────────────────────────
// Editar nombre o dirección de un local
router.patch('/sucursal/:id', authMiddleware, async (req, res) => {
  try {
    const { nombre, direccion } = req.body;
    if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
    const result = await pool.query(
      `UPDATE mis_sucursales SET nombre=$1, direccion=$2
       WHERE id=$3 AND usuario_id=$4 RETURNING *`,
      [nombre.trim(), direccion?.trim() || null, req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Local no encontrado' });
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/multilocal/sucursal/:id ─────────────────────────────────────
// Desactivar (no borrar) un local
router.delete('/sucursal/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE mis_sucursales SET activo=false
       WHERE id=$1 AND usuario_id=$2`,
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Local no encontrado' });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/multilocal/sucursales-publicas/:usuario_id ─────────────────────
// Sin auth — usada por la vista de empleado para listar locales al abrir turno
router.get('/sucursales-publicas/:usuario_id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, direccion FROM mis_sucursales
       WHERE usuario_id=$1 AND activo=true ORDER BY nombre ASC`,
      [req.params.usuario_id]
    );
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
