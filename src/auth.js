const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const { TIPOS_VALIDOS } = require("./benchmarks_sector");
const { enviarBienvenida, enviarRecupero, enviarConfirmacionReset } = require("./mailer");

// ─── POST /api/auth/register ──────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { nombre, email, password, negocio, tipo_negocio, provincia, ciudad, zona } = req.body;
    if (!nombre || !email || !password || !negocio) {
      return res.status(400).json({ error: "Campos obligatorios: nombre, email, password, negocio" });
    }
    if (tipo_negocio && !TIPOS_VALIDOS.includes(tipo_negocio)) {
      return res.status(400).json({ error: `tipo_negocio inválido. Valores aceptados: ${TIPOS_VALIDOS.join(', ')}` });
    }
    const existe = await pool.query("SELECT id FROM usuarios WHERE email=$1", [email]);
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: "Email ya registrado" });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO usuarios(nombre,email,password,negocio,tipo_negocio,provincia,ciudad,zona) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,nombre,email,negocio,tipo_negocio,onboarding_done,provincia,ciudad,zona",
      [nombre, email, hash, negocio, tipo_negocio || null, provincia || null, ciudad || null, zona || null]
    );
    const token = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET, { expiresIn: "30d" });

    // Mail de bienvenida — fire-and-forget, no bloquea la respuesta
    enviarBienvenida({ nombre, email, negocio, tipo_negocio }).catch(() => {});

    res.json({ token, usuario: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query("SELECT * FROM usuarios WHERE email=$1", [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Credenciales incorrectas" });
    }
    const valid = await bcrypt.compare(password, result.rows[0].password);
    if (!valid) {
      return res.status(400).json({ error: "Credenciales incorrectas" });
    }
    const { id, nombre, email: em, negocio, tipo_negocio, onboarding_done } = result.rows[0];
    const token = jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, usuario: { id, nombre, email: em, negocio, tipo_negocio, onboarding_done } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email requerido" });

    const result = await pool.query("SELECT id, nombre FROM usuarios WHERE email=$1", [email]);

    // Siempre responde ok — no revelar si el email existe
    if (result.rows.length === 0) return res.json({ ok: true });

    const { id, nombre } = result.rows[0];
    const resetToken = jwt.sign(
      { id, purpose: "reset" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    const resetUrl = `${process.env.FRONTEND_URL || "https://lumo-psi.vercel.app"}/reset-password?token=${resetToken}`;

    await enviarRecupero({ nombre, email, resetUrl });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "token y password requeridos" });
    if (password.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ error: "El link expiró o es inválido" });
    }
    if (payload.purpose !== "reset") return res.status(400).json({ error: "Token inválido" });

    const hash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE usuarios SET password=$1 WHERE id=$2", [hash, payload.id]);

    // Mail de confirmación — fire-and-forget
    pool.query("SELECT nombre, email FROM usuarios WHERE id=$1", [payload.id])
      .then(r => {
        if (r.rows.length > 0) {
          enviarConfirmacionReset({ nombre: r.rows[0].nombre, email: r.rows[0].email }).catch(() => {});
        }
      })
      .catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
