// frontend_url.js — la dirección pública de la app, definida en UN solo lugar (18/11/2026).
// Antes había tres valores de respaldo distintos (lumo-psi.vercel.app y lumobi.com.ar) y los links de los
// mails (reseteo de contraseña, avisos) podían apuntar a un dominio y la app abrirse en otro.
// Se configura con FRONTEND_URL en Render; si falta, usa el dominio propio.
const FRONTEND_URL = String(process.env.FRONTEND_URL || 'https://lumobi.com.ar').trim().replace(/\/+$/, '');
module.exports = { FRONTEND_URL };
