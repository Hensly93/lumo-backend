// routes_multilocal.js — Lumo S8
// Multi-local: dashboard maestro para dueños con múltiples sucursales
//
// Modelo: un usuario "maestro" puede vincular N usuarios "sucursal"
// La sucursal acepta la invitación y queda asociada al maestro
// El maestro ve KPIs de todas las sucursales en tiempo real

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

// ─── POST /api/multilocal/invitar ────────────────────────────────────────────
// El maestro invita a una sucursal por email
router.post('/invitar', authMiddleware, async (req, res) => {
  try {
    const { email_sucursal, nombre_sucursal } = req.body;
    if (!email_sucursal) return res.status(400).json({ error: 'email_sucursal requerido' });

    // Buscar usuario destino
    const dest = await pool.query('SELECT id, nombre, negocio FROM usuarios WHERE email=$1', [email_sucursal]);
    if (dest.rows.length === 0) {
      return res.status(404).json({ error: 'No existe un usuario con ese email' });
    }
    const sucursalId = dest.rows[0].id;

    if (sucursalId === req.user.id) {
      return res.status(400).json({ error: 'No podés invitarte a vos mismo' });
    }

    await pool.query(
      `INSERT INTO sucursales_red(maestro_id, sucursal_id, nombre_sucursal, estado)
       VALUES($1,$2,$3,'pendiente')
       ON CONFLICT (maestro_id, sucursal_id) DO NOTHING`,
      [req.user.id, sucursalId, nombre_sucursal || dest.rows[0].negocio]
    );

    res.json({ ok: true, sucursal: dest.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/multilocal/aceptar ────────────────────────────────────────────
// La sucursal acepta la invitación del maestro
router.post('/aceptar', authMiddleware, async (req, res) => {
  try {
    const { maestro_id } = req.body;
    if (!maestro_id) return res.status(400).json({ error: 'maestro_id requerido' });

    const result = await pool.query(
      `UPDATE sucursales_red SET estado='activo', aceptado_at=NOW()
       WHERE maestro_id=$1 AND sucursal_id=$2 AND estado='pendiente'
       RETURNING *`,
      [maestro_id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Invitación no encontrada' });
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/multilocal/invitaciones ────────────────────────────────────────
// Ver invitaciones pendientes recibidas
router.get('/invitaciones', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sr.maestro_id, sr.nombre_sucursal, sr.created_at,
              u.nombre as maestro_nombre, u.negocio as maestro_negocio
       FROM sucursales_red sr
       JOIN usuarios u ON u.id = sr.maestro_id
       WHERE sr.sucursal_id=$1 AND sr.estado='pendiente'`,
      [req.user.id]
    );
    res.json({ invitaciones: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/multilocal/red ─────────────────────────────────────────────────
// Dashboard maestro: KPIs de todas las sucursales activas
router.get('/red', authMiddleware, async (req, res) => {
  try {
    const sucursales = await pool.query(
      `SELECT sr.sucursal_id, sr.nombre_sucursal, u.negocio, u.tipo_negocio
       FROM sucursales_red sr
       JOIN usuarios u ON u.id = sr.sucursal_id
       WHERE sr.maestro_id=$1 AND sr.estado='activo'
       ORDER BY sr.nombre_sucursal ASC`,
      [req.user.id]
    );

    if (sucursales.rows.length === 0) {
      return res.json({ sucursales: [], resumen: null });
    }

    // KPIs por sucursal en paralelo
    const kpis = await Promise.all(
      sucursales.rows.map(async (s) => {
        const [ventas, brechas, alertas, turnos] = await Promise.all([
          // Ventas del mes actual
          pool.query(
            `SELECT COALESCE(SUM(monto),0) as total, COUNT(*) as tx
             FROM transacciones
             WHERE usuario_id=$1 AND DATE_TRUNC('month', fecha) = DATE_TRUNC('month', NOW())`,
            [s.sucursal_id]
          ),
          // Brecha promedio últimos 30 días
          pool.query(
            `SELECT COALESCE(AVG(ABS(brecha)),0) as brecha_prom, COUNT(*) as n_turnos
             FROM turnos_caja
             WHERE usuario_id=$1 AND estado='cerrado'
               AND hora_apertura >= NOW() - INTERVAL '30 days'`,
            [s.sucursal_id]
          ),
          // Alertas hoy
          pool.query(
            `SELECT COUNT(*) as total,
                    COUNT(*) FILTER (WHERE prioridad IN ('critico','inconsistencia')) as criticas
             FROM alertas_gestionadas
             WHERE usuario_id=$1 AND created_at >= NOW() - INTERVAL '24 hours'`,
            [s.sucursal_id]
          ),
          // Turno activo ahora
          pool.query(
            `SELECT t.nombre_empleado, t.tipo_turno, t.hora_apertura
             FROM turnos_caja t
             WHERE t.usuario_id=$1 AND t.estado='activo'
             ORDER BY t.hora_apertura DESC LIMIT 1`,
            [s.sucursal_id]
          ),
        ]);

        const brechaVal = parseFloat(brechas.rows[0].brecha_prom);
        const semaforo = brechaVal > 2000 ? 'rojo' : brechaVal > 500 ? 'amarillo' : 'verde';

        return {
          sucursal_id: s.sucursal_id,
          nombre: s.nombre_sucursal,
          negocio: s.negocio,
          tipo_negocio: s.tipo_negocio,
          ventas_mes: parseFloat(ventas.rows[0].total),
          tx_mes: parseInt(ventas.rows[0].tx),
          brecha_promedio: Math.round(brechaVal),
          n_turnos_analizados: parseInt(brechas.rows[0].n_turnos),
          alertas_hoy: parseInt(alertas.rows[0].total),
          alertas_criticas_hoy: parseInt(alertas.rows[0].criticas),
          turno_activo: turnos.rows[0] || null,
          semaforo,
        };
      })
    );

    // Resumen global
    const totalVentas = kpis.reduce((a, b) => a + b.ventas_mes, 0);
    const totalAlertas = kpis.reduce((a, b) => a + b.alertas_criticas_hoy, 0);
    const sucursalesRojo = kpis.filter(k => k.semaforo === 'rojo').length;
    const sucursalesMasVentas = [...kpis].sort((a, b) => b.ventas_mes - a.ventas_mes)[0];
    const sucursalesMasBrechas = [...kpis].sort((a, b) => b.brecha_promedio - a.brecha_promedio)[0];

    res.json({
      sucursales: kpis,
      resumen: {
        total_sucursales: kpis.length,
        ventas_red_mes: Math.round(totalVentas),
        alertas_criticas_hoy: totalAlertas,
        sucursales_en_rojo: sucursalesRojo,
        mejor_sucursal: sucursalesMasVentas?.nombre || null,
        sucursal_mas_brechas: sucursalesMasBrechas?.brecha_promedio > 0 ? sucursalesMasBrechas.nombre : null,
      },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/multilocal/sucursal/:id ─────────────────────────────────────
// El maestro desvincula una sucursal
router.delete('/sucursal/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM sucursales_red WHERE maestro_id=$1 AND sucursal_id=$2',
      [req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
