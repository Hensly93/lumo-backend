// aviso_fundador.js — LumoBi · avisos para el dueño de LumoBi (14/11/2026)
//
// Mientras los clientes son pocos, cada uno se acompaña a mano. Estos avisos le llegan a los mails que
// están en ADMIN_EMAILS (variable de Render) por push y por mail:
//
//   registro            apenas alguien crea su cuenta (con rubro, zona y celular para escribirle)
//   primera_venta       la primera venta de un negocio nuevo
//   primer_turno        el primer cierre de caja (cuánto vendió, diferencia)
//   sin_arrancar_24h    pasó un día y no vendió nada: momento de escribirle
//   prueba_vence        la prueba gratis termina mañana y todavía no pagó
//   resumen_noche       a las 21 h: cómo viene cada negocio en prueba
//
// Nunca rompe nada: si falla, queda en el log y sigue.

const pool = require('./db');

function admins() {
  return String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function usuariosAdmin(db) {
  const lista = admins();
  if (!lista.length) return [];
  const r = await db.query('SELECT id, nombre, email FROM usuarios WHERE LOWER(email) = ANY($1::text[])', [lista]);
  return r.rows;
}

const pesos = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');

// Manda un aviso a los admins. Si se pasa clave, no se repite (queda en vigilante_envios).
async function avisarFundador({ tipo, clave = null, negocioId = null, titulo, mensaje, url = '/admin/embudo' }, db = pool) {
  try {
    const us = await usuariosAdmin(db);
    if (!us.length) return 0;
    if (clave) {
      const ya = await db.query(
        "SELECT 1 FROM vigilante_envios WHERE tipo=$1 AND contexto=$2 AND COALESCE(negocio_id,0)=COALESCE($3,0) LIMIT 1",
        [tipo, clave, negocioId]).catch(() => ({ rows: [] }));
      if (ya.rows.length) return 0;
    }
    const { notificarUsuario } = require('./push');
    let { enviarAvisoVigilante } = {};
    try { ({ enviarAvisoVigilante } = require('./mailer')); } catch (e) { /* sin mailer */ }
    let n = 0;
    for (const u of us) {
      const push = await notificarUsuario(u.id, { title: titulo, body: mensaje, url }, db, null).catch((e) => { console.error('[FUNDADOR] push', e.message); return 0; });
      const mail = enviarAvisoVigilante
        ? await enviarAvisoVigilante({ nombre: u.nombre, email: u.email, negocio: 'LumoBi · clientes', titulo, mensaje, url: (process.env.FRONTEND_URL || 'https://lumobi.com.ar') + url, boton: 'Ver' }).catch(() => false)
        : false;
      n += push > 0 || mail ? 1 : 0;
      if (clave && (push > 0 || mail)) { // si no llegó por ningún lado, se reintenta en la próxima corrida
        await db.query(
          'INSERT INTO vigilante_envios(negocio_id, usuario_id, tipo, contexto, titulo, canales) VALUES($1,$2,$3,$4,$5,$6)',
          [negocioId, u.id, tipo, clave, titulo, [push > 0 ? 'push' : null, mail ? 'email' : null].filter(Boolean).join(',')]).catch(() => {});
      }
    }
    console.log('[FUNDADOR]', tipo, 'negocio', negocioId, 'avisado a', n, 'admin(s)');
    return n;
  } catch (e) {
    console.error('[FUNDADOR]', tipo, e.message);
    return 0;
  }
}

// ── Registro nuevo (se llama desde auth.js, sin esperar) ──
function registroNuevo({ negocioId, negocio, tipo_negocio, provincia, ciudad, zona, nombre, email, celular }) {
  const donde = [zona, ciudad, provincia].filter(Boolean).join(', ');
  return avisarFundador({
    tipo: 'fundador_registro', clave: 'registro', negocioId,
    titulo: `Nuevo registro: ${negocio || 'sin nombre'}`,
    mensaje: `${nombre || 'Alguien'} creó su cuenta${tipo_negocio ? ` · ${tipo_negocio}` : ''}${donde ? ` · ${donde}` : ''}.`
      + `${celular ? ` Celular: ${celular}.` : ''} Mail: ${email}. Es el mejor momento para escribirle y acompañar el arranque: equipo, PIN y caja.`,
  });
}

// ── Pasada del Vigilante (cada hora): hitos de los negocios en sus primeros 30 días ──
async function pasadaFundador(db = pool, reloj) {
  if (!admins().length) return { motivo: 'sin_ADMIN_EMAILS' };
  const neg = await db.query(
    `SELECT n.id, n.nombre, n.created_at, u.email, u.celular, u.subscription_status, u.trial_fin,
            (SELECT MIN(fecha) FROM transacciones t WHERE t.negocio_id=n.id) AS primera_venta,
            (SELECT COUNT(*)::int FROM transacciones t WHERE t.negocio_id=n.id) AS ventas,
            (SELECT COUNT(*)::int FROM transacciones t WHERE t.negocio_id=n.id AND (t.fecha - INTERVAL '3 hours')::date = (NOW() - INTERVAL '3 hours')::date) AS ventas_hoy,
            (SELECT COALESCE(SUM(monto),0)::float FROM transacciones t WHERE t.negocio_id=n.id AND (t.fecha - INTERVAL '3 hours')::date = (NOW() - INTERVAL '3 hours')::date) AS total_hoy,
            (SELECT MIN(hora_cierre) FROM turnos_caja c WHERE c.negocio_id=n.id AND c.estado='cerrado') AS primer_cierre,
            (SELECT COUNT(*)::int FROM empleados_negocio e WHERE e.negocio_id=n.id) AS empleados
     FROM negocios n
     JOIN negocio_usuarios nu ON nu.negocio_id=n.id AND nu.rol='owner' AND nu.activo=true
     JOIN usuarios u ON u.id=nu.usuario_id
     WHERE n.deletion_scheduled_at IS NULL AND n.created_at >= NOW() - INTERVAL '30 days'
       AND LOWER(u.email) <> ALL($1::text[])
     ORDER BY n.id`, [admins()]);
  const ahora = Date.now();
  const resumen = [];
  for (const x of neg.rows) {
    const nombre = x.nombre || `negocio ${x.id}`;
    const contacto = x.celular ? ` Celular: ${x.celular}.` : ` Mail: ${x.email}.`;
    if (x.primera_venta && ahora - new Date(x.primera_venta).getTime() < 3 * 3600 * 1000) {
      await avisarFundador({ tipo: 'fundador_primera_venta', clave: 'primera_venta', negocioId: x.id,
        titulo: `${nombre} hizo su primera venta`, mensaje: `Ya cobró con LumoBi (${x.ventas} venta${x.ventas === 1 ? '' : 's'} hasta ahora).`, url: '/admin/embudo' }, db);
    }
    if (x.primer_cierre && ahora - new Date(x.primer_cierre).getTime() < 3 * 3600 * 1000) {
      const t = await db.query("SELECT brecha FROM turnos_caja WHERE negocio_id=$1 AND estado='cerrado' ORDER BY hora_cierre LIMIT 1", [x.id]);
      const b = t.rows[0] ? Number(t.rows[0].brecha) : null;
      await avisarFundador({ tipo: 'fundador_primer_turno', clave: 'primer_turno', negocioId: x.id,
        titulo: `${nombre} cerró su primer turno`,
        mensaje: `Cerró la primera caja${b != null && Math.abs(b) >= 1 ? ` con ${pesos(b)} de diferencia` : ' sin diferencia'}. Ya le llegó su primer informe: buen momento para preguntarle qué le pareció.` }, db);
    }
    const horas = (ahora - new Date(x.created_at).getTime()) / 3600000;
    if (!x.ventas && horas >= 24) {
      await avisarFundador({ tipo: 'fundador_sin_arrancar', clave: 'sin_arrancar_24h', negocioId: x.id,
        titulo: `${nombre} lleva un día sin arrancar`,
        mensaje: `Se registró hace ${Math.round(horas)} h y no vendió nada${x.empleados ? '' : ' (no cargó equipo)'}.${contacto} Escribile y preguntale dónde se trabó.` }, db);
    }
    if (x.subscription_status === 'trial' && x.trial_fin) {
      const faltan = (new Date(x.trial_fin).getTime() - ahora) / 3600000;
      if (faltan > 0 && faltan <= 30) {
        await avisarFundador({ tipo: 'fundador_prueba_vence', clave: 'prueba_vence', negocioId: x.id,
          titulo: `A ${nombre} se le termina la prueba mañana`,
          mensaje: `${x.ventas} ventas en la prueba.${contacto} Contale qué encontró LumoBi en su negocio antes de que decida.` }, db);
      }
    }
    resumen.push(`${nombre}: ${x.ventas_hoy ? `${x.ventas_hoy} ventas hoy (${pesos(x.total_hoy)})` : x.ventas ? 'sin ventas hoy' : 'todavía no arrancó'}${x.subscription_status ? ` · ${x.subscription_status}` : ''}`);
  }
  // Resumen de la noche
  if (reloj && reloj.hora >= 21 && reloj.hora < 22.5 && resumen.length) {
    await avisarFundador({ tipo: 'fundador_resumen', clave: reloj.hoy, negocioId: null,
      titulo: `Tus clientes hoy (${resumen.length})`, mensaje: resumen.slice(0, 12).join(' · ') }, db);
  }
  return { negocios: neg.rows.length };
}

module.exports = { avisarFundador, registroNuevo, pasadaFundador };
