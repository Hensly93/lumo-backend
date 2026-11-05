// routes_pasos.js — Estado de los "primeros pasos" del negocio. Solo lee: no modifica nada.
//
//   GET /api/pasos/estado  (con login)  ->  { negocio, locales, equipo, ventas, avisos, turno }  (cada uno true/false)

const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');

// Corre una consulta que devuelve una columna "ok". Si falla, lo registra y devuelve false (no rompe la pantalla).
async function existe(sql, params, nombre) {
  try {
    const r = await pool.query(sql, params);
    return !!(r.rows[0] && r.rows[0].ok);
  } catch (e) {
    console.error('pasos: fallo la consulta "' + nombre + '":', e.message);
    return false;
  }
}

router.get('/estado', auth, async (req, res) => {
  try {
    const negocioId = req.user.negocio_id;
    const usuarioId = req.user.id;
    const resultados = await Promise.all([
      existe('SELECT (tipo_negocio IS NOT NULL AND zona IS NOT NULL) AS ok FROM negocios WHERE id=$1', [negocioId], 'negocio'),
      existe("SELECT EXISTS(SELECT 1 FROM mis_sucursales WHERE negocio_id=$1 AND activo=true AND COALESCE(direccion,'') <> '') AS ok", [negocioId], 'locales'),
      existe('SELECT EXISTS(SELECT 1 FROM empleados_negocio WHERE negocio_id=$1 AND activo=true) AS ok', [negocioId], 'equipo'),
      existe("SELECT (EXISTS(SELECT 1 FROM integraciones_mp WHERE usuario_id=$2) OR EXISTS(SELECT 1 FROM transacciones WHERE negocio_id=$1 AND COALESCE(origin,'real')='real')) AS ok", [negocioId, usuarioId], 'ventas'),
      existe('SELECT EXISTS(SELECT 1 FROM push_subscriptions WHERE usuario_id=$1) AS ok', [usuarioId], 'avisos'),
      existe("SELECT EXISTS(SELECT 1 FROM turnos_caja WHERE negocio_id=$1 AND estado='cerrado') AS ok", [negocioId], 'turno'),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      negocio: resultados[0],
      locales: resultados[1],
      equipo: resultados[2],
      ventas: resultados[3],
      avisos: resultados[4],
      turno: resultados[5],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
