// routes_socios.js — gestión de socios e invitaciones del negocio
const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: "Sin token" });
  try {
    req.user = jwt.verify(h.replace("Bearer ", ""), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

// GET /api/socios — listar socios activos del negocio
router.get("/", auth, async (req, res) => {
  try {
    const { negocio_id } = req.user;
    const { rows } = await pool.query(
      `SELECT nu.id, nu.rol, nu.activo, nu.fecha_ingreso,
              u.nombre, u.email,
              inv.email AS email_invitado_por,
              nu.permisos
       FROM negocio_usuarios nu
       JOIN usuarios u ON u.id = nu.usuario_id
       LEFT JOIN usuarios inv ON inv.id = nu.invitado_por
       WHERE nu.negocio_id = $1 AND nu.activo = true
       ORDER BY nu.fecha_ingreso ASC`,
      [negocio_id]
    );
    res.json({ socios: rows });
  } catch (e) {
    console.error("GET /socios error:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /api/socios/invitar — invitar un socio por email
router.post("/invitar", auth, async (req, res) => {
  try {
    const { negocio_id, id: usuario_id } = req.user;
    const { email, rol = "socio" } = req.body;
    if (!email) return res.status(400).json({ error: "Email requerido" });

    const rolesValidos = ["socio", "admin", "viewer"];
    if (!rolesValidos.includes(rol)) return res.status(400).json({ error: "Rol inválido" });

    const { rows: existentes } = await pool.query(
      `SELECT id FROM invitaciones_negocio
       WHERE negocio_id = $1 AND email = $2 AND estado = 'pendiente' AND expira_at > NOW()`,
      [negocio_id, email]
    );
    if (existentes.length > 0) return res.status(409).json({ error: "Ya existe una invitación pendiente para ese email" });

    const token = crypto.randomBytes(32).toString("hex");
    const expira_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO invitaciones_negocio (negocio_id, email, rol, token, invitado_por, estado, expira_at)
       VALUES ($1, $2, $3, $4, $5, 'pendiente', $6)`,
      [negocio_id, email, rol, token, usuario_id, expira_at]
    );

    res.json({ ok: true, mensaje: `Invitación creada para ${email}`, token });
  } catch (e) {
    console.error("POST /socios/invitar error:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// PUT /api/socios/:id/rol — actualizar rol de un socio
router.put("/:id/rol", auth, async (req, res) => {
  try {
    const { negocio_id } = req.user;
    const { id } = req.params;
    const { rol } = req.body;

    const rolesValidos = ["socio", "admin", "viewer"];
    if (!rolesValidos.includes(rol)) return res.status(400).json({ error: "Rol inválido" });

    const { rowCount } = await pool.query(
      `UPDATE negocio_usuarios SET rol = $1
       WHERE id = $2 AND negocio_id = $3 AND activo = true`,
      [rol, id, negocio_id]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Socio no encontrado" });
    res.json({ ok: true, mensaje: "Rol actualizado" });
  } catch (e) {
    console.error("PUT /socios/:id/rol error:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// DELETE /api/socios/:id — remover socio del negocio (soft delete)
router.delete("/:id", auth, async (req, res) => {
  try {
    const { negocio_id, id: usuario_id_solicitante } = req.user;
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT usuario_id FROM negocio_usuarios WHERE id = $1 AND negocio_id = $2`,
      [id, negocio_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Socio no encontrado" });
    if (rows[0].usuario_id === usuario_id_solicitante) return res.status(400).json({ error: "No podés removerte a vos mismo" });

    await pool.query(
      `UPDATE negocio_usuarios SET activo = false WHERE id = $1 AND negocio_id = $2`,
      [id, negocio_id]
    );

    res.json({ ok: true, mensaje: "Socio removido del negocio" });
  } catch (e) {
    console.error("DELETE /socios/:id error:", e);
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;
