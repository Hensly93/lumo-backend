// routes_pasos.js — Estado de los "primeros pasos" del negocio. Solo lee: no modifica nada.
//
//   GET /api/pasos/estado  (con login)  ->  { negocio, locales, equipo, ventas, avisos, turno }  (cada uno true/false)

const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');

// Corre una consulta que devuelve una columna "ok". Si falla, lo registra y devuelve false (no rompe la pantalla).
async function existe(sql, params, nombre, db = pool) {
  try {
    const r = await db.query(sql, params);
    return !!(r.rows[0] && r.rows[0].ok);
  } catch (e) {
    console.error('pasos: fallo la consulta "' + nombre + '":', e.message);
    return false;
  }
}

// Estado de los pasos de un negocio (lo usa la pantalla Primeros pasos y la secuencia de mails de seguimiento)
async function estadoPasos(negocioId, usuarioId, db = pool) {
  const q = (sql, params, nombre) => existe(sql, params, nombre, db);
  const r = await Promise.all([
    q('SELECT (tipo_negocio IS NOT NULL AND zona IS NOT NULL) AS ok FROM negocios WHERE id=$1', [negocioId], 'negocio'),
    q("SELECT EXISTS(SELECT 1 FROM mis_sucursales WHERE negocio_id=$1 AND activo=true AND COALESCE(direccion,'') <> '') AS ok", [negocioId], 'locales'),
    q('SELECT EXISTS(SELECT 1 FROM empleados_negocio WHERE negocio_id=$1 AND activo=true) AS ok', [negocioId], 'equipo'),
    q("SELECT (EXISTS(SELECT 1 FROM integraciones_mp WHERE negocio_id=$1) OR EXISTS(SELECT 1 FROM transacciones WHERE negocio_id=$1 AND COALESCE(origin,'real') IN ('real','importado'))) AS ok", [negocioId], 'ventas'),
    q('SELECT EXISTS(SELECT 1 FROM push_subscriptions WHERE usuario_id=$1) AS ok', [usuarioId], 'avisos'),
    q("SELECT EXISTS(SELECT 1 FROM turnos_caja WHERE negocio_id=$1 AND estado='cerrado') AS ok", [negocioId], 'turno'),
  ]);
  return { negocio: r[0], locales: r[1], equipo: r[2], ventas: r[3], avisos: r[4], turno: r[5] };
}

router.get('/estado', auth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await estadoPasos(req.user.negocio_id, req.user.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.estadoPasos = estadoPasos;
