// plan_gate.js — Estado del plan (prueba / activo / vencido) y bloqueo de lo que no es la vista resumida.
// El plan es del DUEÑO del negocio: socios y empleados siguen el plan del negocio.
// Si algo falla al consultar, NO se bloquea a nadie (mejor dejar pasar que dejar a un cliente afuera por un error nuestro).

const PERMITIDAS = ['/api/auth', '/api/plan', '/api/usuario'];   // con el plan vencido solo se puede entrar, ver el plan y manejar la cuenta
const TTL_MS = 30000;
const cache = new Map();

function bd() { return require('./db'); }

async function estadoPlan(db, negocioId, opts) {
  const o = opts || {};
  const k = String(negocioId);
  const c = cache.get(k);
  if (!o.sinCache && c && Date.now() - c.t < TTL_MS) return c.v;
  const r = await (db || bd()).query(
    `SELECT u.subscription_status AS st,
            u.trial_fin::text AS trial_fin,
            (u.trial_fin IS NOT NULL AND u.trial_fin <= NOW()) AS trial_vencido,
            CASE WHEN u.trial_fin IS NULL THEN NULL
                 ELSE CEIL(EXTRACT(EPOCH FROM (u.trial_fin - NOW())) / 86400.0)::int END AS dias,
            u.subscription_end_date::date::text AS fin,
            (u.subscription_end_date IS NOT NULL
               AND u.subscription_end_date::date < (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) AS fin_vencido,
            CASE WHEN u.subscription_end_date IS NULL THEN NULL
                 ELSE (u.subscription_end_date::date - (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::int END AS dias_fin
     FROM negocio_usuarios nu JOIN usuarios u ON u.id = nu.usuario_id
     WHERE nu.negocio_id = $1 AND nu.rol = 'owner' AND nu.activo = true
     LIMIT 1`, [negocioId]);
  // estado: lo que usa el bloqueo (trial | activa | vencida). suscripcion: lo que se muestra en Ajustes.
  let v;
  const f = r.rows[0];
  const vencida = (fin) => ({ estado: 'vencida', suscripcion: 'vencida', dias_restantes: 0, trial_fin: f.trial_fin, sin_vencimiento: false, fin: fin || null });
  if (!f) v = { estado: 'activa', suscripcion: 'activa', dias_restantes: null, trial_fin: null, sin_vencimiento: true, fin: null };
  else if (f.st === 'expired') v = vencida(f.fin);
  else if (f.st === 'trial') {
    if (f.trial_fin === null) v = { estado: 'trial', suscripcion: 'trial', dias_restantes: null, trial_fin: null, sin_vencimiento: true, fin: null };
    else if (f.trial_vencido) v = vencida(null);
    else v = { estado: 'trial', suscripcion: 'trial', dias_restantes: Math.max(1, f.dias), trial_fin: f.trial_fin, sin_vencimiento: false, fin: null };
  } else if (f.st === 'cancelada' || f.st === 'cancelled') {
    // Cancelo: sigue usando LumoBi hasta el ultimo dia del periodo pagado y despues se bloquea
    if (f.fin && f.fin_vencido) v = vencida(f.fin);
    else v = { estado: 'activa', suscripcion: 'cancelada', cancelada: true, dias_restantes: f.dias_fin, trial_fin: null, sin_vencimiento: !f.fin, fin: f.fin || null };
  } else v = { interna: f.st === 'interna', estado: 'activa', suscripcion: f.st === 'interna' ? 'interna' : 'activa', dias_restantes: null, trial_fin: null, sin_vencimiento: true, fin: f.st === 'interna' ? null : (f.fin || null) };   // activa y cualquier otro estado: no se bloquea
  cache.set(k, { t: Date.now(), v });
  return v;
}

function invalidar(negocioId) { if (negocioId === undefined) cache.clear(); else cache.delete(String(negocioId)); }

async function verificarPlan(req, res, next) {
  try {
    const url = String(req.originalUrl || req.url || '').split('?')[0];
    if (PERMITIDAS.some((p) => url === p || url.startsWith(p + '/'))) return next();
    const est = await estadoPlan(null, req.user && req.user.negocio_id);
    if (est.estado === 'vencida') {
      return res.status(402).json({
        error: 'plan_vencido',
        mensaje: 'Tu prueba terminó. Activá tu plan para seguir usando LumoBi. Tus datos están guardados.',
        plan: est,
      });
    }
  } catch (e) {
    console.error('[PLAN] no se pudo verificar el plan:', e.message);
  }
  next();
}

module.exports = { estadoPlan, verificarPlan, invalidar, PERMITIDAS };
