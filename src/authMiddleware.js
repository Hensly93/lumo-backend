const jwt = require("jsonwebtoken");

/**
 * Middleware de autenticación para rutas protegidas
 * Decodifica el JWT y adjunta req.user con:
 *   - id: usuario.id
 *   - negocio_id: ID del negocio activo
 *   - rol: 'owner' | 'socio'
 */
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Validar que el token tenga negocio_id (tokens viejos no lo tienen)
    if (!payload.negocio_id) {
      return res.status(400).json({ error: 'Token sin negocio_id - re-login requerido' });
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

/**
 * Middleware de autenticación que acepta JWT desde header O query param ?token=
 * Útil para redirects de OAuth donde el browser no puede enviar headers custom
 */
function authWithQuery(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Validar que el token tenga negocio_id (tokens viejos no lo tienen)
    if (!payload.negocio_id) {
      return res.status(400).json({ error: 'Token sin negocio_id - re-login requerido' });
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

module.exports = { auth, authWithQuery };
