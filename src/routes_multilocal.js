// routes_multilocal.js — Lumo S8 (Bug Red)
// El dueño agrega sus propios locales con nombre y dirección.
// No hay invitaciones a otros negocios.
// KPIs por local disponibles cuando transacciones/turnos llevan sucursal_id.

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { geocodificarDireccion } = require('./geocoding');

// ─── POST /api/multilocal/sucursal ───────────────────────────────────────────
// Agregar un local propio (nombre + dirección estructurada + geocoding)
router.post('/sucursal', auth, async (req, res) => {
  try {
    const { nombre, calle, numero, localidad, provincia } = req.body;
    if (!nombre) return res.status(400).json({ error: 'nombre requerido' });

    // Generar direccion legacy como concatenación
    const direccion = calle || numero || localidad || provincia
      ? `${calle || ''} ${numero || ''}, ${localidad || ''}, ${provincia || ''}`.trim()
      : null;

    // Geocodificar si hay datos de dirección
    let latitud = null;
    let longitud = null;
    let geocoding_status = 'pendiente';

    if (calle && localidad) {
      const geoResult = await geocodificarDireccion(calle, numero, localidad, provincia);
      if (geoResult.status === 'ok') {
        latitud = geoResult.lat;
        longitud = geoResult.lon;
        geocoding_status = 'ok';
      } else {
        geocoding_status = 'error';
      }
    }

    const result = await pool.query(
      `INSERT INTO mis_sucursales(
        usuario_id, nombre, direccion, negocio_id,
        calle, numero, localidad, provincia,
        latitud, longitud, geocoding_status, geocoding_fecha
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING *`,
      [
        req.user.id,
        nombre.trim(),
        direccion,
        req.user.negocio_id,
        calle?.trim() || null,
        numero?.trim() || null,
        localidad?.trim() || null,
        provincia?.trim() || null,
        latitud,
        longitud,
        geocoding_status,
      ]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/multilocal/red ─────────────────────────────────────────────────
// Dashboard: lista de locales propios con KPIs
router.get('/red', auth, async (req, res) => {
  try {
    const sucursales = await pool.query(
      `SELECT id, nombre, direccion, activo, created_at,
              calle, numero, localidad, provincia,
              latitud, longitud, geocoding_status
       FROM mis_sucursales
       WHERE negocio_id=$1 AND activo=true
       ORDER BY nombre ASC`,
      [req.user.negocio_id]
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
             WHERE negocio_id=$1 AND sucursal_id=$2
               AND DATE_TRUNC('month', fecha) = DATE_TRUNC('month', NOW())`,
            [req.user.negocio_id, s.id]
          ),
          pool.query(
            `SELECT COALESCE(AVG(ABS(brecha)),0) as brecha_prom, COUNT(*) as n_turnos
             FROM turnos_caja
             WHERE negocio_id=$1 AND sucursal_id=$2 AND estado='cerrado'
               AND hora_apertura >= NOW() - INTERVAL '30 days'`,
            [req.user.negocio_id, s.id]
          ),
          pool.query(
            `SELECT nombre_empleado, tipo_turno, hora_apertura
             FROM turnos_caja
             WHERE negocio_id=$1 AND sucursal_id=$2 AND estado='activo'
             ORDER BY hora_apertura DESC LIMIT 1`,
            [req.user.negocio_id, s.id]
          ),
        ]);

        const brechaVal = parseFloat(brechas.rows[0].brecha_prom);
        const txMes = parseInt(ventas.rows[0].tx);
        const semaforo = txMes === 0 ? 'sin_datos' : brechaVal > 2000 ? 'rojo' : brechaVal > 500 ? 'amarillo' : 'verde';

        return {
          id: s.id,
          nombre: s.nombre,
          direccion: s.direccion,
          calle: s.calle,
          numero: s.numero,
          localidad: s.localidad,
          provincia: s.provincia,
          latitud: s.latitud,
          longitud: s.longitud,
          geocoding_status: s.geocoding_status,
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
// Editar nombre o dirección de un local (con geocoding condicional)
router.patch('/sucursal/:id', auth, async (req, res) => {
  try {
    const { nombre, calle, numero, localidad, provincia } = req.body;
    if (!nombre) return res.status(400).json({ error: 'nombre requerido' });

    // Traer sucursal actual para comparar campos de dirección
    const current = await pool.query(
      `SELECT calle, numero, localidad, provincia, latitud, longitud, geocoding_status
       FROM mis_sucursales
       WHERE id=$1 AND negocio_id=$2`,
      [req.params.id, req.user.negocio_id]
    );

    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'Local no encontrado' });
    }

    const actual = current.rows[0];

    // Regenerar direccion legacy siempre
    const direccion = calle || numero || localidad || provincia
      ? `${calle || ''} ${numero || ''}, ${localidad || ''}, ${provincia || ''}`.trim()
      : null;

    // Comparar los 4 campos de dirección
    const cambioDir = (
      (calle?.trim() || null) !== (actual.calle || null) ||
      (numero?.trim() || null) !== (actual.numero || null) ||
      (localidad?.trim() || null) !== (actual.localidad || null) ||
      (provincia?.trim() || null) !== (actual.provincia || null)
    );

    let latitud = actual.latitud;
    let longitud = actual.longitud;
    let geocoding_status = actual.geocoding_status;

    // Si cambió alguno de los 4 campos: re-geocodificar
    if (cambioDir) {
      if (calle && localidad) {
        const geoResult = await geocodificarDireccion(calle, numero, localidad, provincia);
        if (geoResult.status === 'ok') {
          latitud = geoResult.lat;
          longitud = geoResult.lon;
          geocoding_status = 'ok';
        } else {
          geocoding_status = 'error';
        }
      } else {
        latitud = null;
        longitud = null;
        geocoding_status = 'pendiente';
      }

      // Update con nuevos datos de geocoding y timestamp
      const result = await pool.query(
        `UPDATE mis_sucursales
         SET nombre=$1, direccion=$2,
             calle=$3, numero=$4, localidad=$5, provincia=$6,
             latitud=$7, longitud=$8, geocoding_status=$9, geocoding_fecha=NOW()
         WHERE id=$10 AND negocio_id=$11
         RETURNING *`,
        [
          nombre.trim(),
          direccion,
          calle?.trim() || null,
          numero?.trim() || null,
          localidad?.trim() || null,
          provincia?.trim() || null,
          latitud,
          longitud,
          geocoding_status,
          req.params.id,
          req.user.negocio_id,
        ]
      );
      res.json(result.rows[0]);
    } else {
      // No cambió dirección: no tocar lat/lon/geocoding_status/geocoding_fecha
      const result = await pool.query(
        `UPDATE mis_sucursales
         SET nombre=$1, direccion=$2,
             calle=$3, numero=$4, localidad=$5, provincia=$6
         WHERE id=$7 AND negocio_id=$8
         RETURNING *`,
        [
          nombre.trim(),
          direccion,
          calle?.trim() || null,
          numero?.trim() || null,
          localidad?.trim() || null,
          provincia?.trim() || null,
          req.params.id,
          req.user.negocio_id,
        ]
      );
      res.json(result.rows[0]);
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/multilocal/sucursal/:id ─────────────────────────────────────
// Desactivar (no borrar) un local
router.delete('/sucursal/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE mis_sucursales SET activo=false
       WHERE id=$1 AND negocio_id=$2`,
      [req.params.id, req.user.negocio_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Local no encontrado' });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/multilocal/sucursales-publicas/:negocio_id ─────────────────────
// Sin auth — usada por la vista de empleado para listar locales al abrir turno
router.get('/sucursales-publicas/:negocio_id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, direccion FROM mis_sucursales
       WHERE negocio_id=$1 AND activo=true ORDER BY nombre ASC`,
      [req.params.negocio_id]
    );
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
