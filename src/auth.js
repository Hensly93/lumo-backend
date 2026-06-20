const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const { TIPOS_VALIDOS } = require("./benchmarks_sector");
const { enviarBienvenida, enviarRecupero, enviarConfirmacionReset } = require("./mailer");

// ─── POST /api/auth/register ──────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  const client = await pool.connect();
  try {
    const { nombre, email, password, negocio, tipo_negocio, provincia, ciudad, zona } = req.body;
    if (!nombre || !email || !password || !negocio) {
      return res.status(400).json({ error: "Campos obligatorios: nombre, email, password, negocio" });
    }
    if (tipo_negocio && !TIPOS_VALIDOS.includes(tipo_negocio)) {
      return res.status(400).json({ error: `tipo_negocio inválido. Valores aceptados: ${TIPOS_VALIDOS.join(', ')}` });
    }
    const existe = await client.query("SELECT id FROM usuarios WHERE email=$1", [email]);
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: "Email ya registrado" });
    }

    await client.query('BEGIN');

    // 1. Crear usuario
    const hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      "INSERT INTO usuarios(nombre,email,password) VALUES($1,$2,$3) RETURNING id,nombre,email,onboarding_done",
      [nombre, email, hash]
    );
    const usuario = userResult.rows[0];

    // 2. Crear negocio
    const negocioResult = await client.query(
      "INSERT INTO negocios(nombre,tipo_negocio,provincia,ciudad,zona,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [negocio, tipo_negocio || null, provincia || null, ciudad || null, zona || null, usuario.id]
    );
    const negocio_id = negocioResult.rows[0].id;

    // 3. Vincular usuario como owner
    await client.query(
      "INSERT INTO negocio_usuarios(negocio_id,usuario_id,rol,activo) VALUES($1,$2,'owner',true)",
      [negocio_id, usuario.id]
    );

    await client.query('COMMIT');

    // 4. Generar JWT minimalista
    const token = jwt.sign(
      { id: usuario.id, negocio_id, rol: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    // Mail de bienvenida — fire-and-forget
    enviarBienvenida({ nombre, email, negocio, tipo_negocio }).catch(() => {});

    res.json({ token, usuario: { ...usuario, negocio, tipo_negocio, negocio_id, rol: 'owner' } });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const userResult = await pool.query("SELECT * FROM usuarios WHERE email=$1", [email]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: "Credenciales incorrectas" });
    }
    const valid = await bcrypt.compare(password, userResult.rows[0].password);
    if (!valid) {
      return res.status(400).json({ error: "Credenciales incorrectas" });
    }

    const { id, nombre, email: em, onboarding_done } = userResult.rows[0];

    // Obtener negocio activo del usuario
    const negocioResult = await pool.query(
      `SELECT n.id, n.nombre, n.tipo_negocio, nu.rol
       FROM negocio_usuarios nu
       JOIN negocios n ON n.id = nu.negocio_id
       WHERE nu.usuario_id = $1 AND nu.activo = true
       ORDER BY nu.created_at DESC
       LIMIT 1`,
      [id]
    );

    if (negocioResult.rows.length === 0) {
      return res.status(400).json({ error: "Usuario sin negocio asignado" });
    }

    const { id: negocio_id, nombre: negocio, tipo_negocio, rol } = negocioResult.rows[0];

    // Generar JWT minimalista
    const token = jwt.sign(
      { id, negocio_id, rol },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      token,
      usuario: { id, nombre, email: em, negocio, tipo_negocio, negocio_id, rol, onboarding_done }
    });
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

// ─── POST /api/auth/switch-negocio ────────────────────────────────────────────
router.post("/switch-negocio", async (req, res) => {
  try {
    const { negocio_id } = req.body;
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token requerido' });
    }
    if (!negocio_id) {
      return res.status(400).json({ error: 'negocio_id requerido' });
    }

    let usuario;
    try {
      usuario = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Token inválido' });
    }

    // Validar que el usuario pertenezca a ese negocio
    const negocioResult = await pool.query(
      `SELECT n.id, n.nombre, n.tipo_negocio, nu.rol
       FROM negocio_usuarios nu
       JOIN negocios n ON n.id = nu.negocio_id
       WHERE nu.negocio_id = $1 AND nu.usuario_id = $2 AND nu.activo = true`,
      [negocio_id, usuario.id]
    );

    if (negocioResult.rows.length === 0) {
      return res.status(403).json({ error: 'No tenés acceso a este negocio' });
    }

    const { nombre: negocio, tipo_negocio, rol } = negocioResult.rows[0];

    // Generar nuevo JWT con el negocio seleccionado
    const newToken = jwt.sign(
      { id: usuario.id, negocio_id, rol },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      token: newToken,
      negocio: { id: negocio_id, nombre: negocio, tipo_negocio, rol }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
