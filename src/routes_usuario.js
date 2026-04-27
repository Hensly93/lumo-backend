const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB máx
});

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ─── GET /api/usuario/perfil ──────────────────────────────────────────────────
router.get('/perfil', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, nombre, email, negocio, tipo_negocio, provincia, ciudad, zona, pos, logo, cuit, razon_social FROM usuarios WHERE id=$1',
      [req.user.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/usuario/perfil ────────────────────────────────────────────────
router.patch('/perfil', auth, async (req, res) => {
  try {
    const { nombre, negocio, tipo_negocio, provincia, ciudad, zona, pos, cuit, razon_social } = req.body;
    const r = await pool.query(
      `UPDATE usuarios SET
        nombre        = COALESCE($1, nombre),
        negocio       = COALESCE($2, negocio),
        tipo_negocio  = COALESCE($3, tipo_negocio),
        provincia     = COALESCE($4, provincia),
        ciudad        = COALESCE($5, ciudad),
        zona          = COALESCE($6, zona),
        pos           = COALESCE($7, pos),
        cuit          = COALESCE($8, cuit),
        razon_social  = COALESCE($9, razon_social)
       WHERE id=$10
       RETURNING id, nombre, email, negocio, tipo_negocio, provincia, ciudad, zona, pos, logo, cuit, razon_social`,
      [
        nombre       || null,
        negocio      || null,
        tipo_negocio || null,
        provincia    || null,
        ciudad       || null,
        zona         || null,
        pos          || null,
        cuit         || null,
        razon_social || null,
        req.user.id,
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/usuario/logo ───────────────────────────────────────────────────
router.post('/logo', auth, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const { mimetype, buffer } = req.file;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimetype)) {
      return res.status(400).json({ error: 'Solo JPG, PNG o WebP' });
    }
    const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;
    const r = await pool.query(
      'UPDATE usuarios SET logo=$1 WHERE id=$2 RETURNING logo',
      [dataUrl, req.user.id]
    );
    res.json({ logo: r.rows[0].logo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/usuario/logo ─────────────────────────────────────────────────
router.delete('/logo', auth, async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET logo=NULL WHERE id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/usuario/empleados ───────────────────────────────────────────────
router.get('/empleados', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT e.id, e.nombre, e.activo, e.sucursal_id,
              s.nombre AS sucursal_nombre
       FROM empleados_negocio e
       LEFT JOIN mis_sucursales s ON e.sucursal_id = s.id
       WHERE e.usuario_id=$1 AND e.activo=true
       ORDER BY e.nombre`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/usuario/empleados ─────────────────────────────────────────────
router.post('/empleados', auth, async (req, res) => {
  try {
    const { nombre, pin, sucursal_id } = req.body;
    if (!nombre || !pin) return res.status(400).json({ error: 'nombre y pin requeridos' });
    if (String(pin).length !== 4 || isNaN(Number(pin))) {
      return res.status(400).json({ error: 'PIN debe ser 4 dígitos numéricos' });
    }
    const pin_hash = await bcrypt.hash(String(pin), 10);
    const r = await pool.query(
      `INSERT INTO empleados_negocio(usuario_id, nombre, pin_hash, sucursal_id)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(usuario_id, nombre)
       DO UPDATE SET pin_hash=$3, sucursal_id=$4, activo=true
       RETURNING id, nombre, sucursal_id, activo`,
      [req.user.id, nombre.trim(), pin_hash, sucursal_id || null]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/usuario/empleados/:id ────────────────────────────────────────
router.patch('/empleados/:id', auth, async (req, res) => {
  try {
    const { nombre, pin, sucursal_id } = req.body;

    const emp = await pool.query(
      'SELECT id, pin_hash FROM empleados_negocio WHERE id=$1 AND usuario_id=$2',
      [req.params.id, req.user.id]
    );
    if (emp.rows.length === 0) return res.status(404).json({ error: 'Empleado no encontrado' });

    let pin_hash = emp.rows[0].pin_hash;
    if (pin !== undefined && pin !== '') {
      if (String(pin).length !== 4 || isNaN(Number(pin))) {
        return res.status(400).json({ error: 'PIN debe ser 4 dígitos numéricos' });
      }
      pin_hash = await bcrypt.hash(String(pin), 10);
    }

    const r = await pool.query(
      `UPDATE empleados_negocio SET
        nombre      = COALESCE($1, nombre),
        pin_hash    = $2,
        sucursal_id = COALESCE($3, sucursal_id)
       WHERE id=$4 AND usuario_id=$5
       RETURNING id, nombre, sucursal_id, activo`,
      [nombre?.trim() || null, pin_hash, sucursal_id || null, req.params.id, req.user.id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/usuario/empleados/:id ───────────────────────────────────────
router.delete('/empleados/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE empleados_negocio SET activo=false WHERE id=$1 AND usuario_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/usuario/notificaciones ─────────────────────────────────────────
router.get('/notificaciones', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT notificaciones_config FROM usuarios WHERE id=$1',
      [req.user.id]
    );
    const defaults = {
      alertas_criticas:  true,
      alertas_medias:    true,
      conteos_perdidos:  true,
      resumen_diario:    false,
    };
    res.json({ ...defaults, ...(r.rows[0]?.notificaciones_config || {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/usuario/notificaciones ───────────────────────────────────────
router.patch('/notificaciones', auth, async (req, res) => {
  try {
    const allowed = ['alertas_criticas', 'alertas_medias', 'conteos_perdidos', 'resumen_diario'];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = Boolean(req.body[key]);
    }
    await pool.query(
      `UPDATE usuarios SET notificaciones_config = notificaciones_config || $1::jsonb WHERE id=$2`,
      [JSON.stringify(patch), req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
