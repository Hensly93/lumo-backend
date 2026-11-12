// Rutas para que LumoBi reconozca "el mismo producto" aunque esté escrito distinto, y reconozca la marca.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { authTurno } = require('./sesion_empleado');
const I = require('./producto_identidad');
const { asegurar: asegurarMarca } = require('./catalogo_marca');

const fallo = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Error interno' });

// Empleado al cargar un producto nuevo: ¿ya existe algo parecido? ¿qué marca se reconoce?
router.get('/empleado/parecidos', authTurno, async (req, res) => {
  try {
    const nombre = String(req.query.nombre || '').trim().slice(0, 150);
    if (nombre.length < 3) return res.json({ parecidos: [], marca_sugerida: null });
    await asegurarMarca();
    const t = await pool.query(`SELECT negocio_id FROM turnos_caja WHERE id=$1 AND estado='activo'`, [req.turno.id]);
    if (!t.rows.length) return res.status(400).json({ error: 'Turno no activo' });
    res.json(await I.buscarParecidos(t.rows[0].negocio_id, nombre, pool));
  } catch (e) { fallo(res, e); }
});

// Dueño: lo mismo, para el formulario del catálogo
router.get('/parecidos', auth, async (req, res) => {
  try {
    const nombre = String(req.query.nombre || '').trim().slice(0, 150);
    if (nombre.length < 3) return res.json({ parecidos: [], marca_sugerida: null });
    await asegurarMarca();
    res.json(await I.buscarParecidos(req.user.negocio_id, nombre, pool));
  } catch (e) { fallo(res, e); }
});

// Marcas que ya usa el negocio (para autocompletar)
router.get('/marcas', auth, async (req, res) => {
  try { await asegurarMarca(); res.json({ marcas: await I.marcasConocidas(req.user.negocio_id, pool) }); } catch (e) { fallo(res, e); }
});

// Grupos del catálogo que parecen ser el mismo producto
router.get('/duplicados', auth, async (req, res) => {
  try { await asegurarMarca(); res.json({ grupos: await I.sugerirUnificaciones(req.user.negocio_id, pool) }); } catch (e) { fallo(res, e); }
});

// Marcas escritas distinto que parecen la misma ("Oreo" / "Orio")
router.get('/marcas-parecidas', auth, async (req, res) => {
  try {
    await asegurarMarca();
    const r = await pool.query(`SELECT marca, COUNT(*)::int AS productos FROM productos WHERE negocio_id=$1 AND COALESCE(activo,true) AND marca IS NOT NULL AND marca<>'' GROUP BY marca ORDER BY productos DESC`, [req.user.negocio_id]);
    const m = r.rows, usado = new Set(), grupos = [];
    for (let i = 0; i < m.length; i++) {
      if (usado.has(i)) continue;
      const g = [m[i]];
      for (let j = i + 1; j < m.length; j++) {
        if (usado.has(j)) continue;
        const a = I.analizar(m[i].marca).palabras.join(' '), b = I.analizar(m[j].marca).palabras.join(' ');
        if (a && b && (a === b || I.mismaPalabra(a, b))) { g.push(m[j]); usado.add(j); }
      }
      if (g.length > 1) grupos.push({ sugerida: g[0].marca, marcas: g });
    }
    res.json({ grupos });
  } catch (e) { fallo(res, e); }
});

// El dueño confirma: unir productos (los demás pasan al elegido) o unificar una marca
router.post('/unificar', auth, async (req, res) => {
  try {
    await asegurarMarca();
    const { queda_id, ids } = req.body || {};
    if (!Number.isInteger(Number(queda_id)) || !Array.isArray(ids)) return res.status(400).json({ error: 'Datos inválidos' });
    res.json(await I.unificar(req.user.negocio_id, Number(queda_id), ids, pool));
  } catch (e) { fallo(res, e); }
});

router.post('/unificar-marca', auth, async (req, res) => {
  try {
    await asegurarMarca();
    const { marca, desde } = req.body || {};
    const destino = require('./catalogo_marca').limpiarMarca(marca);
    if (!destino || !Array.isArray(desde) || !desde.length) return res.status(400).json({ error: 'Datos inválidos' });
    const r = await pool.query(`UPDATE productos SET marca=$1, updated_at=NOW() WHERE negocio_id=$2 AND marca = ANY($3::text[])`, [destino, req.user.negocio_id, desde.map(String).slice(0, 20)]);
    res.json({ ok: true, productos: r.rowCount });
  } catch (e) { fallo(res, e); }
});

module.exports = router;
