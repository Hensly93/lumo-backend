// centro_mando.js — LumoBi hacia adentro (15/11/2026)
//
// El panel del fundador: qué hace cada cliente, quién está en riesgo de irse, a quién escribirle hoy y hacia dónde va el negocio.
// Todo sale de datos reales (cuentas, ventas, Mercado Pago, avisos, analitica_eventos). Las reglas de riesgo son simples y se
// muestran enteras: cada puntaje trae sus motivos. No es un modelo predictivo; con pocas cuentas no se puede validar uno.
//
// Lo que NO se puede saber (los navegadores no lo avisan): si el cliente borró la app. Se muestra "instalada" (evento) y
// "la abrió hace N días" (sesiones en modo app). Si dejó de abrirla, se dice eso, no que la borró.

const pool = require('./db');
const { calcularPrecio } = require('./precios');

const DIA_MS = 86400000;
const dias = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / DIA_MS) : null);

async function asegurarNotas() {
  await pool.query(`CREATE TABLE IF NOT EXISTS crm_notas (
    id BIGSERIAL PRIMARY KEY, usuario_id INTEGER NOT NULL, tipo VARCHAR(12) NOT NULL DEFAULT 'nota',
    texto TEXT NOT NULL, creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query('CREATE INDEX IF NOT EXISTS crm_notas_usuario ON crm_notas (usuario_id, creado DESC)');
}

function whatsapp(celular) {
  let d = String(celular || '').replace(/\D/g, '');
  if (!d) return null;
  d = d.replace(/^00/, '');
  if (d.startsWith('549')) return d;
  if (d.startsWith('54')) return '549' + d.slice(2).replace(/^9/, '');
  d = d.replace(/^0/, '');
  if (d.length === 10) return '549' + d;
  if (d.length === 12 && d.startsWith('15')) return null;
  return d.length >= 10 ? d : null;
}

function precioPotencial(n) {
  try {
    const loc = Math.max(1, Number(n.locales_declarados) || 1);
    const cajas = Array(loc).fill(Math.max(1, Number(n.cajas_declaradas) || 1));
    const p = calcularPrecio(cajas, Number(n.empleados_declarados) || 0);
    return p && p.precio ? Math.round(p.precio) : null;
  } catch (e) { return null; }
}

// Reglas de riesgo: cada una suma puntos y deja escrito por qué.
function evaluar(c) {
  const motivos = [];
  let pts = 0;
  const suma = (p, m) => { pts += p; motivos.push(m); };
  const pago = ['active', 'activa'].includes(c.estado);
  const desdeRegistro = dias(c.registro);

  if (c.sin_medicion) {
    motivos.push('Sin datos de uso: se registró antes de que empezáramos a medir.');
  } else if (c.ultimo_dias == null) {
    if (desdeRegistro != null && desdeRegistro >= 3) suma(35, `Se registró hace ${desdeRegistro} días y no hay ninguna visita registrada.`);
  } else if (c.ultimo_dias >= 14) suma(45, `Hace ${c.ultimo_dias} días que no entra.`);
  else if (c.ultimo_dias >= 7) suma(30, `Hace ${c.ultimo_dias} días que no entra.`);
  else if (c.ultimo_dias >= 4) suma(15, `Hace ${c.ultimo_dias} días que no entra.`);

  if (c.dias_prev7 >= 2 && c.dias_7 * 2 < c.dias_prev7) suma(20, `Entró ${c.dias_7} días esta semana contra ${c.dias_prev7} la anterior.`);

  if (c.dias_ventas >= 3 && c.ventas_ultima_dias != null && c.ventas_ultima_dias > 7) suma(25, `Dejó de cargar ventas: la última fue hace ${c.ventas_ultima_dias} días.`);
  if (c.dias_ventas === 0 && desdeRegistro != null && desdeRegistro >= 3 && !pago) suma(25, `Todavía no cargó ninguna venta (se registró hace ${desdeRegistro} días).`);

  if (c.estado === 'trial' && c.trial_fin) {
    const resta = Math.ceil((new Date(c.trial_fin).getTime() - Date.now()) / DIA_MS);
    if (resta < 0) suma(30, `La prueba venció hace ${-resta} días y no pagó.`);
    else if (resta <= 3 && c.dias_ventas < 3) suma(25, resta === 0 ? 'La prueba vence hoy y casi no la usó.' : `La prueba vence en ${resta} día${resta === 1 ? '' : 's'} y casi no la usó.`);
  }

  if (c.pwa_instalada && c.pwa_ultima_dias != null && c.pwa_ultima_dias > 10) suma(10, `Instaló la app pero hace ${c.pwa_ultima_dias} días que no la abre.`);

  pts = Math.min(100, pts);
  const nivel = pago && pts < 60 ? 'bajo' : pts >= 60 ? 'alto' : pts >= 20 ? 'medio' : 'bajo';

  let etapa;
  if (pago) etapa = 'Pagando';
  else if (c.ultimo_dias != null && c.ultimo_dias >= 14) etapa = 'Dormido';
  else if (c.dias_ventas >= 3 && (c.ultimo_dias == null || c.ultimo_dias <= 7)) etapa = 'Activo';
  else if (desdeRegistro != null && desdeRegistro < 3 && c.dias_ventas === 0) etapa = 'Nuevo';
  else etapa = 'Sin activar';
  return { riesgo: pts, nivel, motivos, etapa };
}

function mensaje(c, ev) {
  const nom = String(c.nombre_persona || '').trim().split(/\s+/)[0] || '';
  const hola = nom ? `Hola ${nom}!` : 'Hola!';
  const firma = 'Soy Hens, de LumoBi.';
  const m = ev.motivos[0] || '';
  if (/ninguna venta|no cargó/.test(m)) return { accion: 'Ayudalo a cargar sus primeras ventas', texto: `${hola} ${firma} Vi que te registraste pero todavía no cargaste tus ventas. ¿Querés que te ayude? Con una foto del cuaderno o un Excel alcanza, y en 5 minutos te muestro dónde se te está yendo la plata.` };
  if (/vence|venció/.test(m)) return { accion: 'Hablá con él antes de que se le termine la prueba', texto: `${hola} ${firma} Tu prueba de LumoBi ${/venció/.test(m) ? 'ya terminó' : 'está por terminar'}. ¿Pudiste ver qué fugas te encontró? Si querés lo repasamos juntos y te cuento cómo seguir.` };
  if (/ventas/.test(m)) return { accion: 'Preguntale por qué dejó de cargar ventas', texto: `${hola} ${firma} Vi que hace unos días no cargás ventas en LumoBi. ¿Pasó algo o te costó usarlo? Contame y lo resolvemos, tu análisis se afina con cada día de datos.` };
  if (/no entra|no la abre|visita/.test(m)) return { accion: 'Escribile para ver si necesita ayuda', texto: `${hola} ${firma} Hace unos días que no te veo por LumoBi. ¿Te sirvió lo que encontramos? Si algo no se entendió, decime y lo arreglo.` };
  return { accion: 'Mantené el contacto', texto: `${hola} ${firma} ¿Cómo te va con LumoBi? Cualquier cosa que quieras mejorar, contame.` };
}

// ─── Lista de clientes con todo lo que sabemos ──────────────────────────────

async function clientes({ incluirPruebas = false } = {}) {
  const [primero] = (await pool.query('SELECT MIN(creado) p FROM analitica_eventos')).rows;
  const r = await pool.query(`
    SELECT u.id AS usuario_id, u.nombre AS nombre_persona, u.negocio AS negocio, u.email, u.celular,
           COALESCE(u.trial_inicio, u.created_at) AS registro, u.trial_fin, COALESCE(u.subscription_status,'sin_estado') AS estado,
           (u.es_prueba IS TRUE OR COALESCE(u.subscription_status,'')='interna' OR u.email ILIKE '%@test.%' OR u.email ILIKE '%@example.%') AS prueba,
           n.id AS negocio_id, n.locales_declarados, n.cajas_declaradas, n.empleados_declarados,
           EXISTS (SELECT 1 FROM integraciones_mp i WHERE i.negocio_id = n.id) AS mp,
           (SELECT COUNT(*)::int FROM push_subscriptions p WHERE p.usuario_id = u.id) AS avisos,
           ev.ultimo, ev.dias_7, ev.dias_prev7, ev.pwa_instalada, ev.pwa_ultima, ev.pwa_oferta, ev.eventos,
           vt.dias_ventas, vt.ultima_venta, vt.ventas_7, vt.ventas_prev7
    FROM usuarios u
    JOIN negocio_usuarios nu ON nu.usuario_id = u.id AND nu.rol = 'owner' AND nu.activo = true
    JOIN negocios n ON n.id = nu.negocio_id
    LEFT JOIN LATERAL (
      SELECT MAX(a.creado) ultimo, COUNT(*)::int eventos,
        COUNT(DISTINCT (a.creado AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) FILTER (WHERE a.creado >= NOW() - INTERVAL '7 days')::int dias_7,
        COUNT(DISTINCT (a.creado AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) FILTER (WHERE a.creado >= NOW() - INTERVAL '14 days' AND a.creado < NOW() - INTERVAL '7 days')::int dias_prev7,
        BOOL_OR(a.tipo = 'pwa_instalada') pwa_instalada,
        MAX(a.creado) FILTER (WHERE a.disp = 'pwa') pwa_ultima,
        BOOL_OR(a.tipo IN ('pwa_oferta','pwa_click')) pwa_oferta
      FROM analitica_eventos a WHERE a.usuario_id = u.id::text OR a.negocio_id = n.id::text) ev ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT (t.fecha - INTERVAL '3 hours')::date)::int dias_ventas, MAX(t.fecha - INTERVAL '3 hours') ultima_venta,
        COUNT(*) FILTER (WHERE t.fecha >= NOW() - INTERVAL '7 days')::int ventas_7,
        COUNT(*) FILTER (WHERE t.fecha >= NOW() - INTERVAL '14 days' AND t.fecha < NOW() - INTERVAL '7 days')::int ventas_prev7
      FROM transacciones t WHERE t.negocio_id = n.id AND COALESCE(t.origin,'real') IN ('real','importado')) vt ON true
    ORDER BY COALESCE(u.trial_inicio, u.created_at) DESC NULLS LAST LIMIT 300`);
  await asegurarNotas();
  const notas = (await pool.query(`SELECT usuario_id, MAX(creado) FILTER (WHERE tipo='contacto') ult_contacto, COUNT(*)::int n FROM crm_notas GROUP BY 1`)).rows;
  const mn = new Map(notas.map((x) => [x.usuario_id, x]));

  return r.rows.filter((c) => incluirPruebas || !c.prueba).map((c) => {
    c.ultimo_dias = dias(c.ultimo);
    c.pwa_ultima_dias = dias(c.pwa_ultima);
    c.ventas_ultima_dias = dias(c.ultima_venta);
    c.sin_medicion = !c.eventos && primero && primero.p && new Date(c.registro) < new Date(primero.p);
    const ev = evaluar(c);
    const msg = mensaje(c, ev);
    const nn = mn.get(c.usuario_id);
    const contactoDias = nn && nn.ult_contacto ? dias(nn.ult_contacto) : null;
    const wa = whatsapp(c.celular);
    return {
      usuario_id: c.usuario_id, negocio_id: c.negocio_id, negocio: c.negocio, persona: c.nombre_persona, email: c.email,
      celular: c.celular || null, registro: c.registro, estado_plan: c.estado, prueba: c.prueba,
      etapa: ev.etapa, riesgo: ev.riesgo, nivel: ev.nivel, motivos: ev.motivos,
      ultimo_visto: c.ultimo, ultimo_dias: c.ultimo_dias, dias_activos_7: c.dias_7 || 0, dias_activos_prev7: c.dias_prev7 || 0,
      app: { instalada: !!c.pwa_instalada, la_abrio_hace_dias: c.pwa_ultima_dias, vio_la_oferta: !!c.pwa_oferta, avisos_activados: c.avisos > 0 },
      mp: c.mp, dias_con_ventas: c.dias_ventas || 0, ultima_venta_dias: c.ventas_ultima_dias,
      ventas_7: c.ventas_7 || 0, ventas_prev7: c.ventas_prev7 || 0,
      precio_potencial: precioPotencial(c),
      prueba_vence: c.trial_fin,
      contactado_hace_dias: contactoDias, notas: nn ? nn.n : 0,
      accion: msg.accion, mensaje: msg.texto,
      whatsapp: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(msg.texto)}` : null,
      mailto: c.email ? `mailto:${c.email}?subject=${encodeURIComponent('LumoBi')}&body=${encodeURIComponent(msg.texto)}` : null,
    };
  });
}

// ─── Panorama: números clave, a quién escribirle hoy y hacia dónde va ───────

async function panorama() {
  const todos = await clientes();
  const vivos = todos.filter((c) => c.etapa !== 'Pagando');
  const cuenta = (f) => todos.filter(f).length;

  // Semanas: cuentas creadas y cuántas llegaron a 3 días de ventas
  const sem = (await pool.query(`
    SELECT date_trunc('week', COALESCE(u.trial_inicio,u.created_at) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text AS semana, COUNT(*)::int AS registros
    FROM usuarios u JOIN negocio_usuarios nu ON nu.usuario_id=u.id AND nu.rol='owner' AND nu.activo=true
    WHERE COALESCE(u.trial_inicio,u.created_at) >= NOW() - INTERVAL '8 weeks'
      AND NOT (u.es_prueba IS TRUE OR COALESCE(u.subscription_status,'')='interna' OR u.email ILIKE '%@test.%' OR u.email ILIKE '%@example.%')
    GROUP BY 1 ORDER BY 1`)).rows;
  const ult4 = sem.slice(-4);
  const prom = ult4.length ? ult4.reduce((a, b) => a + b.registros, 0) / ult4.length : 0;
  const maduras = todos.filter((c) => dias(c.registro) >= 14);
  const tasaAct = maduras.length ? maduras.filter((c) => c.dias_con_ventas >= 3).length / maduras.length : null;
  // Con menos de 3 semanas de historia no se proyecta: sería inventar una tendencia.
  const reg30 = sem.length >= 3 ? Math.round(prom * (30 / 7)) : null;

  const potActivos = todos.filter((c) => c.etapa === 'Activo' && c.precio_potencial).reduce((a, c) => a + c.precio_potencial, 0);
  const potRiesgo = todos.filter((c) => c.nivel === 'alto' && c.precio_potencial).reduce((a, c) => a + c.precio_potencial, 0);

  const hoy = vivos
    .filter((c) => c.riesgo >= 25 && (c.contactado_hace_dias == null || c.contactado_hace_dias >= 3))
    .sort((a, b) => b.riesgo - a.riesgo).slice(0, 10);

  return {
    generado: new Date().toISOString(),
    cuentas: todos.length,
    kpis: {
      nuevas_7: cuenta((c) => dias(c.registro) <= 6),
      nuevas_prev7: cuenta((c) => dias(c.registro) >= 7 && dias(c.registro) <= 13),
      activas_semana: cuenta((c) => c.ultimo_dias != null && c.ultimo_dias <= 6),
      activadas: cuenta((c) => c.dias_con_ventas >= 3),
      pagando: cuenta((c) => c.etapa === 'Pagando'),
      en_riesgo: cuenta((c) => c.nivel === 'alto' && c.etapa !== 'Pagando'),
      dormidas: cuenta((c) => c.etapa === 'Dormido'),
      pruebas_por_vencer: cuenta((c) => c.estado_plan === 'trial' && c.prueba_vence && new Date(c.prueba_vence).getTime() - Date.now() < 4 * DIA_MS && new Date(c.prueba_vence).getTime() > Date.now()),
      con_app: cuenta((c) => c.app.instalada),
      con_avisos: cuenta((c) => c.app.avisos_activados),
      con_mp: cuenta((c) => c.mp),
    },
    por_etapa: ['Nuevo', 'Sin activar', 'Activo', 'Pagando', 'Dormido'].map((e) => ({ etapa: e, n: cuenta((c) => c.etapa === e) })),
    hoy,
    proyeccion: {
      semanas: sem,
      registros_30d: reg30,
      tasa_activacion: tasaAct == null ? null : Math.round(tasaAct * 100),
      activadas_30d: tasaAct == null || reg30 == null ? null : Math.round(reg30 * tasaAct),
      plata_potencial_activos: potActivos, plata_en_riesgo: potRiesgo,
      confianza: sem.length < 3 ? 'Todavía hay menos de 3 semanas de historia: no proyectamos para no inventar una tendencia.' : maduras.length < 30 ? `Pocas cuentas (${maduras.length} con más de 14 días): tomalo como orientación, no como promesa.` : 'Calculado con el ritmo de las últimas 4 semanas.',
      nota_plata: 'Precio potencial según el tamaño que declaró cada cuenta. El cobro automático todavía no existe: no es plata cobrada.',
    },
  };
}

// ─── Ficha de un cliente ────────────────────────────────────────────────────

async function ficha(usuarioId) {
  const lista = await clientes({ incluirPruebas: true });
  const c = lista.find((x) => x.usuario_id === usuarioId);
  if (!c) return null;
  const nid = String(c.negocio_id), uid = String(usuarioId);
  const ids = [uid, nid];
  const W = `(usuario_id = $1 OR negocio_id = $2)`;
  const [dia, pant, acc, hitos, errs, notas] = await Promise.all([
    pool.query(`SELECT (creado AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text dia, COUNT(*)::int eventos
                FROM analitica_eventos WHERE ${W} AND creado >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1`, ids),
    pool.query(`SELECT ruta, COUNT(*)::int vistas FROM analitica_eventos WHERE ${W} AND tipo='pantalla' AND creado >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, ids),
    pool.query(`SELECT COALESCE(d->>'t', d->>'p') que, COUNT(*)::int veces FROM analitica_eventos WHERE ${W} AND tipo IN ('click','accion_api') AND creado >= NOW() - INTERVAL '30 days' AND COALESCE(d->>'t', d->>'p') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, ids),
    pool.query(`SELECT tipo, MIN(creado) primera FROM analitica_eventos WHERE ${W} AND tipo IN ('registro_ok','login_ok','pwa_oferta','pwa_click','pwa_instalada','mp_vista','mp_conectar','mp_ahora_no','mp_desconectar') GROUP BY 1 ORDER BY 2`, ids),
    pool.query(`SELECT tipo, ruta, COALESCE(d->>'m', d->>'p') detalle, creado FROM analitica_eventos WHERE ${W} AND tipo IN ('error','api_error') ORDER BY creado DESC LIMIT 5`, ids),
    pool.query('SELECT id, tipo, texto, creado FROM crm_notas WHERE usuario_id=$1 ORDER BY creado DESC LIMIT 50', [usuarioId]),
  ]);
  const ETIQ = { registro_ok: 'Se registró', login_ok: 'Primer ingreso medido', pwa_oferta: 'Le mostramos instalar la app', pwa_click: 'Tocó "Instalar app"', pwa_instalada: 'Instaló la app', mp_vista: 'Vio la pantalla de Mercado Pago', mp_conectar: 'Tocó "Conectar Mercado Pago"', mp_ahora_no: 'Eligió "Ahora no" en Mercado Pago', mp_desconectar: 'Desconectó Mercado Pago' };
  return {
    cliente: c,
    actividad_30d: dia.rows,
    pantallas: pant.rows,
    acciones: acc.rows,
    hitos: hitos.rows.map((h) => ({ que: ETIQ[h.tipo] || h.tipo, cuando: h.primera })),
    errores: errs.rows,
    notas: notas.rows,
    aclaracion_app: 'Los navegadores no avisan si alguien borra la app. Mostramos si la instaló y cuándo fue la última vez que la abrió.',
  };
}

async function agregarNota(usuarioId, texto, tipo) {
  await asegurarNotas();
  const t = String(texto || '').trim().slice(0, 1000);
  if (!t) throw new Error('La nota está vacía');
  const tp = tipo === 'contacto' ? 'contacto' : 'nota';
  const r = await pool.query('INSERT INTO crm_notas (usuario_id, tipo, texto) VALUES ($1,$2,$3) RETURNING id, tipo, texto, creado', [usuarioId, tp, t]);
  return r.rows[0];
}

module.exports = { clientes, panorama, ficha, agregarNota, asegurarNotas, _evaluar: evaluar };
