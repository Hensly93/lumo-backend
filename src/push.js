// push.js — Lumo S9
// Wrapper de web-push para notificaciones PWA.
// Suscripciones guardadas en push_subscriptions.
// Si una suscripción expiró (410) se elimina automáticamente.

const webpush = require('web-push');

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

async function notificarUsuario(usuarioId, payload, db) {
  ensureVapid();
  const subsRes = await db.query(
    'SELECT * FROM push_subscriptions WHERE usuario_id = $1',
    [usuarioId]
  );

  for (const row of subsRes.rows) {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Suscripción expirada o inválida — eliminar
        await db.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
      } else {
        console.error('[PUSH] Error enviando a', row.endpoint, e.message);
      }
    }
  }
}

async function notificarTodos(usuarioIds, payload, db) {
  await Promise.all(usuarioIds.map(id => notificarUsuario(id, payload, db).catch(() => {})));
}

module.exports = { notificarUsuario, notificarTodos };
