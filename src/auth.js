const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const { TIPOS_VALIDOS } = require("./benchmarks_sector");

router.post("/register", async (req, res) => {
  try {
    const { nombre, email, password, negocio, tipo_negocio } = req.body;
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
      "INSERT INTO usuarios(nombre,email,password,negocio,tipo_negocio) VALUES($1,$2,$3,$4,$5) RETURNING id,nombre,email,negocio,tipo_negocio",
      [nombre, email, hash, negocio, tipo_negocio || null]
    );
    const token = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, usuario: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    const { id, nombre, email: em, negocio, tipo_negocio } = result.rows[0];
    const token = jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, usuario: { id, nombre, email: em, negocio, tipo_negocio } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
