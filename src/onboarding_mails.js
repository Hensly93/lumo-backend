// onboarding_mails.js — LumoBi · seguimiento después del registro (18/11/2026).
//
// Problema: el cliente se registraba, recibía el mail de bienvenida y después nadie le volvía a hablar.
// Acá: unos pocos mails que lo llevan, de a UN paso, hasta que el negocio esté andando.
//
// Cuentas anteriores a esta función: si nunca recibieron ninguno y ya pasó un día y medio, no se les escribe.
// Cuándo escribe (desde el registro): a las 2 h, a las 8 h y después cada 24 h (días 1, 2, 3, 4, 5 y 7). 8 mails como máximo.
// Cuándo NO escribe:
//   · si el negocio ya está activado (ventas cargadas y un turno de caja cerrado),
//   · si la persona pidió no recibirlos (link de baja en cada mail),
//   · cuentas de prueba o con baja programada,
//   · de noche (solo entre las 9 y las 21 h de Argentina),
//   · si se atrasó la corrida: manda el que corresponde ahora, nunca varios juntos.
// Qué dice: el avance, UN paso (el próximo que falta), qué gana con ese paso, cuánto tarda y qué NO puede ver LumoBi sin él.
// Todo lo que afirma es verificable: no inventa porcentajes, testimonios ni urgencias falsas.
const crypto = require('crypto');
const express = require('express');
const pool = require('./db');
const BASE_URL = require('./frontend_url').FRONTEND_URL;

const HORAS_SLOT = [2, 8, 24, 48, 72, 96, 120, 168];
const HORA_DESDE = 9;
const HORA_HASTA = 21;
const SEPARACION_MIN_H = 4;
const MAX_HORAS_PRIMER_MAIL = 36;

// Pasos en el orden en que se piden. "nucleo" = lo que hace falta para que LumoBi empiece a cuidar la plata.
const PASOS = [
  { k: 'negocio', nombre: 'Contanos de tu negocio: rubro y zona', min: '1 minuto',
    gana: 'Con el rubro y la zona, LumoBi te compara con negocios parecidos al tuyo y sabe qué es normal para vos.',
    sin: 'Sin esto, los avisos son genéricos y no podemos decirte si tu ticket o tus horarios están bien o mal para tu rubro.' },
  { k: 'ventas', nombre: 'Cargar tus ventas', min: '5 minutos', nucleo: true,
    gana: 'Con tus ventas, LumoBi ve qué días y horas vendés más, qué se te escapa y cuánta plata dejás sobre la mesa.',
    sin: 'Sin ventas, LumoBi no puede detectar nada: no hay contra qué comparar. Es la pieza que lo prende todo.' },
  { k: 'equipo', nombre: 'Sumar a quien atiende la caja', min: '2 minutos',
    gana: 'Cada persona entra con su PIN. Así cada turno queda a nombre de alguien y se puede ver dónde falta plata sin acusar a nadie.',
    sin: 'Sin equipo cargado, la caja no tiene responsable y no se puede separar un turno de otro.' },
  { k: 'turno', nombre: 'Cerrar tu primer turno de caja', min: '3 minutos', nucleo: true,
    gana: 'Al cerrar el turno, LumoBi compara lo que tenía que haber en la caja con lo que hay. Es lo que encuentra faltantes y diferencias.',
    sin: 'Sin un turno cerrado no hay control de caja, y es justo donde más plata se pierde sin que nadie se dé cuenta.' },
  { k: 'avisos', nombre: 'Activar los avisos en tu celular', min: '30 segundos',
    gana: 'Te avisamos cuando pasa algo que importa (una venta anulada rara, un día flojo, un faltante) sin que tengas que abrir la app.',
    sin: 'Sin avisos, te enterás de los problemas cuando entrás a mirar; con avisos, te enterás cuando pasan.' },
];

const { firmar } = (() => {
  const secreto = () => String(process.env.JWT_SECRET || 'lumobi');
  return { firmar: (uid) => crypto.createHmac('sha256', secreto()).update('baja-onboarding:' + uid).digest('hex').slice(0, 32) };
})();

// El link de baja va al backend; el backend responde una página simple. BASE_URL del backend se toma de BACKEND_URL si existe.
function urlBajaAbsoluta(uid) {
  const back = String(process.env.BACKEND_URL || 'https://lumo-backend-1.onrender.com').trim().replace(/\/+$/, '');
  return `${back}/api/onboarding/baja?u=${uid}&t=${firmar(uid)}`;
}

async function asegurarTablas(db = pool) {
  await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mails_onboarding_baja BOOLEAN NOT NULL DEFAULT false`);
  await db.query(`CREATE TABLE IF NOT EXISTS onboarding_envios(
    usuario_id INTEGER NOT NULL, slot INTEGER NOT NULL, enviado BOOLEAN NOT NULL DEFAULT false,
    asunto TEXT, creado TIMESTAMP DEFAULT NOW(), PRIMARY KEY (usuario_id, slot))`);
}

// Qué pasos hizo la persona (reusa las mismas consultas de la pantalla Primeros pasos)
function resumenPasos(est) {
  const lista = PASOS.map((p) => ({ ...p, hecho: !!est[p.k] }));
  const pendientes = lista.filter((p) => !p.hecho);
  return {
    lista, pendientes, hechos: lista.length - pendientes.length, total: lista.length,
    activado: lista.filter((p) => p.nucleo).every((p) => p.hecho),
    proximo: pendientes.find((p) => p.nucleo) || pendientes[0] || null,
  };
}

// Copy de cada mail. Cada uno tiene una idea distinta, para que no se sienta repetido.
function armarMail(slot, { nombre, negocio, r }) {
  const p = r.proximo;
  const n = String(nombre || '').trim().split(/\s+/)[0] || 'Hola';
  const url = `${BASE_URL}/primeros-pasos`;
  const base = { url, checklist: r.lista.map((x) => ({ nombre: x.nombre, hecho: x.hecho })), hechos: r.hechos, total: r.total, boton: `${p.nombre} (${p.min})` };
  const que = [{ titulo: `Qué te da: ${p.nombre.toLowerCase()}`, texto: p.gana }];

  switch (slot) {
    case 0: return { ...base,
      asunto: `${n}, tu cuenta ya está lista: falta un solo paso`,
      preheader: `Te lleva ${p.min}. Después LumoBi empieza a buscar dónde se te va la plata.`,
      titulo: `${n}, ya hiciste lo más difícil: crear la cuenta`,
      intro: `${negocio ? negocio + ' ya está en LumoBi.' : 'Tu cuenta ya está en LumoBi.'} Para que empiece a cuidar tu plata hace falta un paso y nada más: te lleva ${p.min}.`,
      bloques: que, cierre: 'Si preferís que lo veamos juntos, respondé este mail y te ayudamos a dejarlo andando.' };
    case 1: return { ...base,
      asunto: `Así empieza a verse tu negocio en LumoBi`,
      preheader: `Un ejemplo de lo que aparece apenas hay datos, y el paso que falta.`,
      titulo: `Esto es lo que LumoBi te muestra cuando tiene tus datos`,
      intro: `Con tus ventas y tu caja, la app te dice cosas concretas, por ejemplo: «los martes de 15 a 17 h vendés la mitad que el resto de la semana», o «en este turno faltaron $4.000 en la caja». (Son ejemplos ilustrativos; los tuyos van a ser con tus números.)`,
      bloques: [...que, { titulo: 'Qué pasa si no lo hacés', texto: p.sin }] };
    case 2: return { ...base,
      asunto: `Cómo hace LumoBi para encontrar dónde se te va la plata`,
      preheader: `Explicado en 30 segundos, sin vueltas.`,
      titulo: `Cómo funciona, en simple`,
      intro: `LumoBi no adivina: compara. Mira lo que vendiste, lo que tenía que haber en la caja y lo que es normal para tu rubro, y te avisa cuando algo no cierra. Para comparar necesita datos tuyos.`,
      bloques: [...que, { titulo: 'Lo que tenés que hacer hoy', texto: `Una sola cosa, que lleva ${p.min}. Todo lo demás lo hace LumoBi.` }] };
    case 3: return { ...base,
      asunto: `${n}, esto es lo que LumoBi todavía no puede ver de tu negocio`,
      preheader: `Mientras faltan datos, hay cosas que nadie está mirando por vos.`,
      titulo: `Hoy hay cosas de tu negocio que nadie está mirando`,
      intro: `Mientras falten datos, LumoBi no puede avisarte de nada. No es que no haya problemas: es que todavía no los puede ver. Y cada día sin cargar es un día de ventas que no queda para comparar después.`,
      bloques: [{ titulo: 'Lo que hoy no puede ver', texto: p.sin }, ...que] };
    case 4: return { ...base,
      asunto: `Es más fácil de lo que parece`,
      preheader: `Se hace desde el celular, no hace falta ser técnico.`,
      titulo: `Si te frenó que parezca complicado: no lo es`,
      intro: `Se hace desde el celu y por pasos, sin instalar nada raro. Podés subir tus ventas desde un archivo, conectar Mercado Pago o cargarlas desde la caja, y el resto lo ordena LumoBi.`,
      bloques: que, cierre: 'Si algo no se entiende, respondé este mail y te lo explicamos.' };
    case 5: return { ...base,
      asunto: `${n}, ¿te trabaste con algo?`,
      preheader: `Respondé este mail con una palabra y te ayudamos.`,
      titulo: `¿Hubo algo que te frenó?`,
      intro: `Queremos saber si hay algo que no se entiende o no funciona. Respondé este mail con lo que sea, aunque sea una palabra, y lo vemos nosotros directamente.`,
      bloques: [{ titulo: 'Si fue falta de tiempo', texto: `El paso que sigue lleva ${p.min}. Podés dejarlo hecho ahora y listo.` }, ...que] };
    case 6: return { ...base,
      asunto: `Lo primero que suelen encontrar los comercios con LumoBi`,
      preheader: `Tres cosas que se ven rápido cuando hay datos.`,
      titulo: `Qué se encuentra primero cuando hay datos`,
      intro: `En comercios como el tuyo, lo que más rápido aparece suele ser: productos que se venden por debajo de lo que cuestan, diferencias de caja que se repiten en el mismo turno y días u horarios flojos que se pueden mejorar. Para ver cuál es el tuyo hace falta cargar los datos.`,
      bloques: que };
    default: return { ...base,
      asunto: `Último aviso: tu cuenta queda lista para cuando quieras`,
      preheader: `No te escribimos más con recordatorios.`,
      titulo: `Este es el último recordatorio`,
      intro: `Para no llenarte la casilla, no te escribimos más con recordatorios. Tu cuenta queda exactamente como está y podés retomar cuando quieras, desde el paso donde dejaste.`,
      bloques: que, cierre: 'Si hay algo que te ayudaría a empezar, respondé este mail y lo vemos.' };
  }
}

function relojAR(ahora) {
  const l = new Date(ahora.getTime() - 3 * 3600 * 1000);
  return { hora: l.getUTCHours() + l.getUTCMinutes() / 60 };
}
function esCorreoDePrueba(email) { return /@(test\.com|example\.com|example\.org|test\.test)$/i.test(String(email || '').trim()); }

// opts: { dry, ahora (Date), email (fn), estado (fn(negocioId, usuarioId)) } — todo opcional, para pruebas
async function pasadaOnboarding(db = pool, opts = {}) {
  const ahora = opts.ahora || new Date();
  const res = { dry: !!opts.dry, revisados: 0, enviados: 0, detalle: [] };
  const h = relojAR(ahora).hora;
  if (h < HORA_DESDE || h >= HORA_HASTA) { res.motivo = 'fuera_de_horario'; return res; }
  await asegurarTablas(db);
  const enviar = opts.email || require('./mailer').enviarSeguimiento;
  const estadoFn = opts.estado || ((nid, uid) => require('./routes_pasos').estadoPasos(nid, uid, db));

  const ult = Math.max(...HORAS_SLOT) + 12; // pasada esta edad no se mira más
  const us = await db.query(
    `SELECT u.id AS usuario_id, nu.negocio_id, u.nombre, u.email, u.negocio, u.created_at,
            EXTRACT(EPOCH FROM (($1::timestamptz AT TIME ZONE 'UTC') - u.created_at)) / 3600.0 AS horas
     FROM usuarios u
     JOIN negocio_usuarios nu ON nu.usuario_id = u.id AND nu.rol = 'owner' AND nu.activo = true
     WHERE u.mails_onboarding_baja = false AND u.deletion_scheduled_at IS NULL
       AND COALESCE(u.es_prueba, false) = false
       AND u.created_at <= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '${HORAS_SLOT[0]} hours'
       AND u.created_at >= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '${ult} hours'`, [ahora.toISOString()]);

  for (const u of us.rows) {
    if (esCorreoDePrueba(u.email)) continue;
    res.revisados++;
    try {
      const horas = Number(u.horas);
      const vencidos = HORAS_SLOT.map((hh, i) => [hh, i]).filter(([hh]) => horas >= hh).map(([, i]) => i);
      if (!vencidos.length) continue;
      const prev = await db.query('SELECT slot, enviado, creado FROM onboarding_envios WHERE usuario_id=$1', [u.usuario_id]);
      const hechos = new Set(prev.rows.map((x) => x.slot));
      const toca = vencidos.filter((i) => !hechos.has(i));
      if (!toca.length) continue;
      const slot = toca[toca.length - 1];          // solo el más reciente: nunca varios de golpe
      // Quien nunca recibió ninguno y ya pasó el primer día y medio es una cuenta anterior a esta secuencia: no se le escribe a mitad de camino
      if (!prev.rows.some((x) => x.enviado) && horas >= MAX_HORAS_PRIMER_MAIL) { res.detalle.push({ usuario_id: u.usuario_id, accion: 'cuenta_anterior_no_se_envia' }); continue; }
      const ultimo = prev.rows.filter((x) => x.enviado).map((x) => new Date(x.creado).getTime()).sort().pop();
      if (ultimo && (ahora.getTime() - ultimo) / 3600000 < SEPARACION_MIN_H) continue;

      const r = resumenPasos(await estadoFn(u.negocio_id, u.usuario_id));
      if (r.activado || !r.proximo) {              // ya está andando: se cierra la secuencia sin molestar
        if (!opts.dry) for (const i of toca) await db.query('INSERT INTO onboarding_envios(usuario_id, slot, enviado, asunto) VALUES($1,$2,false,$3) ON CONFLICT DO NOTHING', [u.usuario_id, i, 'activado']);
        res.detalle.push({ usuario_id: u.usuario_id, slot, accion: 'activado_no_se_envia' });
        continue;
      }
      const mail = armarMail(slot, { nombre: u.nombre, negocio: u.negocio, r });
      res.detalle.push({ usuario_id: u.usuario_id, slot, asunto: mail.asunto, proximo: r.proximo.k, avance: `${r.hechos}/${r.total}` });
      if (opts.dry) continue;
      // se anota ANTES de enviar: si el mail falla, no se reintenta en bucle (mejor perder uno que mandar dos)
      for (const i of toca) await db.query('INSERT INTO onboarding_envios(usuario_id, slot, enviado, asunto) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [u.usuario_id, i, i === slot, i === slot ? mail.asunto : 'saltado']);
      const ok = await enviar({ ...mail, email: u.email, bajaUrl: urlBajaAbsoluta(u.usuario_id) });
      if (ok) res.enviados++;
    } catch (e) {
      console.error('[ONBOARDING] usuario', u.usuario_id, e.message);
      res.detalle.push({ usuario_id: u.usuario_id, error: e.message });
    }
  }
  console.log('[ONBOARDING] revisados=' + res.revisados + ' enviados=' + res.enviados);
  return res;
}

// Página de baja: GET /api/onboarding/baja?u=ID&t=FIRMA  (sin login, pero firmada: no se puede dar de baja a otro)
const router = express.Router();
router.get('/baja', async (req, res) => {
  const uid = parseInt(req.query.u, 10);
  const ok = Number.isInteger(uid) && String(req.query.t || '') === firmar(uid);
  const pagina = (t, m) => `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LumoBi</title><body style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#0A1628"><h1 style="font-size:22px">${t}</h1><p style="line-height:1.6;color:#45546B">${m}</p><p><a href="${BASE_URL}" style="color:#0A5BD3">Ir a LumoBi</a></p></body></html>`;
  if (!ok) return res.status(400).send(pagina('Link inválido', 'Este link de baja no es válido. Escribinos a hola@lumobi.com.ar y lo resolvemos.'));
  try {
    await asegurarTablas();
    await pool.query('UPDATE usuarios SET mails_onboarding_baja = true WHERE id=$1', [uid]);
    res.send(pagina('Listo, no te escribimos más', 'Dejaste de recibir los recordatorios de configuración. Tu cuenta sigue igual y los avisos de tu negocio no cambian.'));
  } catch (e) {
    console.error('[ONBOARDING] baja', e.message);
    res.status(500).send(pagina('No pudimos procesarlo', 'Escribinos a hola@lumobi.com.ar y te damos de baja a mano.'));
  }
});

module.exports = { pasadaOnboarding, armarMail, resumenPasos, router, HORAS_SLOT, PASOS, firmar, asegurarTablas };
