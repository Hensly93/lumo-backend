const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("./db");

// Huella corta de la contraseña: si cambia la contraseña, los tokens viejos dejan de servir
function huellaPassword(hash) {
  return crypto.createHash("sha256").update(String(hash || "")).digest("hex").slice(0, 12);
}

// ¿El usuario sigue activo en ese negocio y el token es de su contraseña actual?
// Cache de 60 s por token para no consultar la base en cada pedido.
const cacheAcceso = new Map();
async function accesoVigente(payload) {
  const clave = payload.id + ":" + payload.negocio_id + ":" + (payload.pv || "");
  const c = cacheAcceso.get(clave);
  if (c && c.hasta > Date.now()) return c.ok;
  const r = await pool.query(
    `SELECT u.password FROM negocio_usuarios nu JOIN usuarios u ON u.id = nu.usuario_id
     WHERE nu.usuario_id=$1 AND nu.negocio_id=$2 AND nu.activo=true AND u.deletion_scheduled_at IS NULL`,
    [payload.id, payload.negocio_id]
  );
  let ok = r.rows.length > 0;
  // Tokens nuevos traen pv; los emitidos antes de este cambio se aceptan hasta que venzan
  if (ok && payload.pv) ok = payload.pv === huellaPassword(r.rows[0].password);
  cacheAcceso.set(clave, { ok, hasta: Date.now() + 60000 });
  if (cacheAcceso.size > 5000) cacheAcceso.clear();
  return ok;
}

/**
 * Middleware de autenticación para rutas protegidas
 * Decodifica el JWT y adjunta req.user con:
 *   - id: usuario.id
 *   - negocio_id: ID del negocio activo
 *   - rol: 'owner' | 'socio'
 */
function auth(req, res, next) {
  let payload;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);

    // Validar que el token tenga negocio_id (tokens viejos no lo tienen)
    if (!payload.negocio_id || payload.purpose) {
      return res.status(400).json({ error: 'Token sin negocio_id - re-login requerido' });
    }

    req.user = payload;
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
  // Socio dado de baja o contraseña cambiada: el token deja de servir
  accesoVigente(req.user).then((ok) => {
    if (!ok) return res.status(401).json({ error: 'Sesión vencida. Volvé a ingresar.' });
    next();
  }).catch(() => next()); // si la base no responde, no se bloquea a todos
}

/**
 * Middleware de autenticación que acepta JWT desde header O query param ?token=
 * Útil para redirects de OAuth donde el browser no puede enviar headers custom
 */
function authWithQuery(req, res, next) {
  let payload;
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);

    // Validar que el token tenga negocio_id (tokens viejos no lo tienen)
    if (!payload.negocio_id || payload.purpose) {
      return res.status(400).json({ error: 'Token sin negocio_id - re-login requerido' });
    }

    req.user = payload;
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
  // Socio dado de baja o contraseña cambiada: el token deja de servir
  accesoVigente(req.user).then((ok) => {
    if (!ok) return res.status(401).json({ error: 'Sesión vencida. Volvé a ingresar.' });
    next();
  }).catch(() => next()); // si la base no responde, no se bloquea a todos
}

// Con el plan vencido solo se puede entrar, ver el plan y manejar la cuenta (ver plan_gate.js)
const { verificarPlan } = require('./plan_gate');
const iaPresupuesto = require('./ia_presupuesto');
function conPlan(fn) {
  return function (req, res, next) {
    fn(req, res, function (err) {
      if (err) return next(err);
      if (!req.user) return next();
      verificarPlan(req, res, function (e) {
        if (e) return next(e);
        iaPresupuesto.correrConNegocio(req.user.negocio_id, () => next());
      });
    });
  };
}

module.exports = { auth: conPlan(auth), authWithQuery: conPlan(authWithQuery), huellaPassword };
