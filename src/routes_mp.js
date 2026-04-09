// routes_mp.js — Lumo v2.0
// OAuth Mercado Pago — estructura lista para credenciales reales.
// Sesión 7: completar con APP_ID y CLIENT_SECRET reales de developers.mercadopago.com

const express = require('express');
const router = express.Router();
const pool = require('./db');
const { verificarToken } = require('./auth');

const MP_APP_ID = process.env.MP_APP_ID || '';
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || '';
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI || 'https://lumo-backend-production.up.railway.app/api/mp/callback';

router.get('/auth', verificarToken, (req, res) => {
  if (!MP_APP_ID) {
    return res.status(503).json({
      error: 'Integración MP no configurada. Completar en Sesión 7.',
    });
  }
  const url = `https://auth.mercadopago.com.ar/authorization?client_id=${MP_APP_ID}&response_type=code&platform_id=mp&redirect_uri=${encodeURIComponent(MP_REDIRECT_URI)}&state=${req.usuario.id}`;
  res.json({ url });
});

router.get('/callback', async (req, res) => {
  const { code, state: usuarioId } = req.query;
  if (!code || !usuarioId) {
    return res.status(400).json({ error: 'Parámetros de callback inválidos' });
  }
  if (!MP_CLIENT_SECRET) {
    return res.status(503).json({
      error: 'Credenciales MP no configuradas. Completar en Sesión 7.',
    });
  }
  try {
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MP_APP_ID,
        client_secret: MP_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: MP_REDIRECT_URI,
      }),
    });
    const data = await response.json();
    if (!data.access_token) {
      return res.status(400).json({ error: 'Error al obtener token de MP' });
    }
    await pool.query(
      `UPDATE usuarios 
       SET mp_access_token = $1, mp_user_id = $2, mp_conectado = true
       WHERE id = $3`
