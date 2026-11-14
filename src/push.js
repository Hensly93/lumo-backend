// push.js — Lumo S9
// Wrapper de web-push para notificaciones PWA.
// Suscripciones guardadas en push_subscriptions.
// Si una suscripción expiró (410) se elimina automáticamente.

const webpush = require('web-push');

const PREF_DEFAULTS = {
  alertas_criticas: true,
  alertas_medias: true,
  conteos_perdidos: true,
  resumen_diario: true,
  cierres_limpios: false,
};

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  vapidConfigured = true;
}

async function notificarUsuario(usuarioId, payload, db, tipo = null, detalle = null) {
  // Si tipo especificado, verificar preferencias ANTES de buscar suscripciones
  if (tipo) {
    const prefRes = await db.query(
      'SELECT notificaciones_config FROM usuarios WHERE id = $1',
      [usuarioId]
    );
    const config = prefRes.rows[0]?.notificaciones_config || {};

    // Defaults si no existe la key. Tienen que ser IGUALES a los del Vigilante y a los de Ajustes:
    // antes resumen_diario era false acá y true en el Vigilante, así que el briefing, el informe de cada
    // turno, la franja fuerte y la predicción de mañana se "enviaban" pero el push nunca salía.
    const defaults = PREF_DEFAULTS;

    const enabled = config[tipo] ?? defaults[tipo];

    // Si está desactivado, salir sin enviar
    if (!enabled) {
      return 0;
    }
  }

  ensureVapid();

  const subsRes = await db.query(
    'SELECT * FROM push_subscriptions WHERE usuario_id = $1',
    [usuarioId]
  );

  let entregados = 0;
  for (const row of subsRes.rows) {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    let host = '';
    try { host = new URL(row.endpoint).host; } catch (e) { /* endpoint raro */ }
    try {
      // TTL 12 h: si el celu está apagado, el aviso llega igual cuando se prende (y no un aviso viejo de días)
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 12 * 3600, urgency: 'high' });
      entregados++;
      if (detalle) detalle.push({ id: row.id, host, ok: true });
    } catch (e) {
      // 404/410: el celu dio de baja la suscripción. 403: se creó con otra clave VAPID. En los tres casos no sirve más.
      const muerta = [404, 410, 403].includes(e.statusCode);
      if (muerta) await db.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
      console.error('[PUSH] usuario', usuarioId, host, 'status', e.statusCode, muerta ? '(suscripción borrada)' : '', e.body || e.message);
      if (detalle) detalle.push({ id: row.id, host, ok: false, status: e.statusCode || null, borrada: muerta, error: String(e.body || e.message).slice(0, 200) });
    }
  }
  return entregados;
}

async function notificarTodos(usuarioIds, payload, db) {
  await Promise.all(usuarioIds.map(id => notificarUsuario(id, payload, db).catch(() => {})));
}

module.exports = { notificarUsuario, notificarTodos, PREF_DEFAULTS };
