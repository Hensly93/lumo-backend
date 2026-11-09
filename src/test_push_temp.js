// test_push_temp.js — Script temporal de prueba PUSH NOTIFICATIONS contra PRODUCCIÓN
// Uso: node src/test_push_temp.js [usuarioId]
// Si no se pasa usuarioId, lista todos los usuarios con push_subscriptions

require('dotenv').config();
const { Pool } = require('pg');
const webpush = require('web-push');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Configurar VAPID
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:castellyholy@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function listarUsuariosConPush() {
  console.log('\n📊 USUARIOS CON PUSH SUBSCRIPTIONS\n');

  const res = await pool.query(`
    SELECT
      u.id,
      u.nombre,
      u.email,
      u.notificaciones_config,
      COUNT(ps.id) as num_subscriptions,
      MAX(ps.created_at) as ultima_subscription
    FROM usuarios u
    LEFT JOIN push_subscriptions ps ON ps.usuario_id = u.id
    GROUP BY u.id, u.nombre, u.email, u.notificaciones_config
    ORDER BY num_subscriptions DESC, u.id
  `);

  if (res.rows.length === 0) {
    console.log('❌ No hay usuarios en la DB de producción');
    return [];
  }

  console.log('┌─────┬──────────────────────────┬───────────────────────────────┬──────────────┬─────────────────────┐');
  console.log('│ ID  │ Nombre                   │ Email                         │ Subscriptions│ Última Sub          │');
  console.log('├─────┼──────────────────────────┼───────────────────────────────┼──────────────┼─────────────────────┤');

  res.rows.forEach(r => {
    const id = String(r.id).padEnd(3);
    const nombre = (r.nombre || 'Sin nombre').padEnd(24).substring(0, 24);
    const email = (r.email || 'Sin email').padEnd(29).substring(0, 29);
    const subs = String(r.num_subscriptions).padEnd(12);
    const fecha = r.ultima_subscription
      ? new Date(r.ultima_subscription).toISOString().substring(0, 19).replace('T', ' ')
      : 'N/A                 ';

    console.log(`│ ${id} │ ${nombre} │ ${email} │ ${subs} │ ${fecha} │`);

    if (r.notificaciones_config) {
      const cfg = r.notificaciones_config;
      const items = [];
      if (cfg.alertas_criticas !== undefined) items.push(`críticas:${cfg.alertas_criticas ? '✓' : '✗'}`);
      if (cfg.alertas_medias !== undefined) items.push(`medias:${cfg.alertas_medias ? '✓' : '✗'}`);
      if (cfg.conteos_perdidos !== undefined) items.push(`conteos:${cfg.conteos_perdidos ? '✓' : '✗'}`);
      if (cfg.resumen_diario !== undefined) items.push(`resumen:${cfg.resumen_diario ? '✓' : '✗'}`);
      if (items.length > 0) {
        console.log(`│     │ Config: ${items.join(', ')}`.padEnd(107) + '│');
      }
    }
  });

  console.log('└─────┴──────────────────────────┴───────────────────────────────┴──────────────┴─────────────────────┘\n');

  return res.rows;
}

async function verDetallesPush(usuarioId) {
  console.log(`\n🔍 DETALLES PUSH SUBSCRIPTIONS — Usuario ${usuarioId}\n`);

  const res = await pool.query(
    'SELECT * FROM push_subscriptions WHERE usuario_id = $1 ORDER BY created_at DESC',
    [usuarioId]
  );

  if (res.rows.length === 0) {
    console.log('❌ Este usuario NO tiene push_subscriptions activas\n');
    return [];
  }

  console.log(`✅ ${res.rows.length} subscription(s) encontrada(s):\n`);

  res.rows.forEach((s, idx) => {
    console.log(`[${idx + 1}] ID: ${s.id}`);
    console.log(`    Endpoint: ${s.endpoint.substring(0, 80)}...`);
    console.log(`    p256dh: ${s.p256dh.substring(0, 40)}...`);
    console.log(`    auth: ${s.auth.substring(0, 30)}...`);
    console.log(`    Created: ${new Date(s.created_at).toISOString()}`);
    console.log('');
  });

  return res.rows;
}

async function enviarNotificacionPrueba(usuarioId) {
  console.log(`\n📤 ENVIANDO NOTIFICACIÓN DE PRUEBA — Usuario ${usuarioId}\n`);

  const subsRes = await pool.query(
    'SELECT * FROM push_subscriptions WHERE usuario_id = $1',
    [usuarioId]
  );

  if (subsRes.rows.length === 0) {
    console.log('❌ No hay subscriptions activas para enviar\n');
    return;
  }

  const payload = {
    title: '🧪 Test Push Notification',
    body: `Prueba de notificación enviada a las ${new Date().toLocaleTimeString('es-AR')}`,
    timestamp: new Date().toISOString(),
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: 'test-push',
    data: {
      url: '/analisis',
      test: true
    }
  };

  console.log('📦 Payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('\n');

  let enviados = 0;
  let fallidos = 0;
  let eliminados = 0;

  for (const row of subsRes.rows) {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };

    console.log(`Enviando a subscription #${row.id}...`);

    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      console.log(`  ✅ Enviado exitosamente`);
      enviados++;
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);

      if (e.statusCode === 410 || e.statusCode === 404) {
        console.log(`  🗑️  Subscription expirada/inválida — ELIMINANDO de la DB`);
        await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
        eliminados++;
      } else {
        console.log(`  ⚠️  Error temporal: código ${e.statusCode || 'N/A'}`);
        fallidos++;
      }
    }

    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('📊 RESUMEN');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`✅ Enviados:   ${enviados}`);
  console.log(`❌ Fallidos:   ${fallidos}`);
  console.log(`🗑️  Eliminados: ${eliminados}`);
  console.log(`📦 Total subs: ${subsRes.rows.length}`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

async function main() {
  const usuarioId = process.argv[2];

  try {
    console.log('\n╔═══════════════════════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                         🔔 LUMO PUSH NOTIFICATIONS TEST — PRODUCCIÓN                             ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════════════════════════╝');

    console.log(`\n🔗 DB: ${process.env.DATABASE_URL.split('@')[1].split('/')[0]}`);
    console.log(`🔑 VAPID configurado: ${process.env.VAPID_PUBLIC_KEY ? '✅' : '❌'}\n`);

    const usuarios = await listarUsuariosConPush();

    if (!usuarioId) {
      console.log('💡 Para enviar una notificación de prueba, ejecutá:');
      console.log('   node src/test_push_temp.js <usuarioId>\n');

      const conSubs = usuarios.filter(u => u.num_subscriptions > 0);
      if (conSubs.length > 0) {
        console.log('👥 Usuarios disponibles para test:');
        conSubs.forEach(u => {
          console.log(`   → Usuario ${u.id} (${u.nombre}) — ${u.num_subscriptions} subscription(s)`);
        });
        console.log('');
      }
    } else {
      const usuario = usuarios.find(u => u.id === parseInt(usuarioId));
      if (!usuario) {
        console.log(`❌ Usuario ${usuarioId} no existe en la DB\n`);
        process.exit(1);
      }

      console.log(`👤 Usuario seleccionado: ${usuario.nombre} (${usuario.email})`);

      await verDetallesPush(usuarioId);
      await enviarNotificacionPrueba(usuarioId);
    }

  } catch (error) {
    console.error('\n❌ ERROR FATAL:\n', error);
  } finally {
    await pool.end();
  }
}

main();
