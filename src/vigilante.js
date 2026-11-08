// vigilante.js — LumoBi · avisos proactivos (5/11/2026)
//
// Hasta ahora NICOLE solo pensaba cuando alguien abria una pantalla. El Vigilante corre cada hora,
// ejecuta los mismos calculos que muestra la app y le avisa al dueño (email + push). Cada aviso abre
// la pantalla donde se ve lo mismo.
//
//   Resumen y ritmo del dia
//   · briefing_matutino     "Buen dia": lo que se espera hoy (prediccion, clima, feriado/cobro)  -> /predicciones
//   · ritmo_bajo / alto     hoy se vende bien por debajo / por encima de lo normal a esta hora   -> /
//   · resumen_diario        cierre del dia contra un dia normal                                  -> /
//   · lluvia                esta lloviendo o va a llover + cuanto te afecta (si ya lo aprendio)  -> /predicciones
//   Lo que NICOLE detecta (mismos calculos de las pantallas)
//   · nicole_senal          alertas criticas / de atencion / positivas                           -> /alertas
//   · erm_empleados         señales en el equipo (sin nombres)                                   -> /empleados
//   · rentabilidad          recomendaciones de rentabilidad / punto de equilibrio                -> /rentabilidad
//   Operacion
//   · sin_ventas_hoy, turno_sin_abrir, caja_abierta_larga                                        -> / y /empleado
//   · datos_desactualizados, sin_datos (cuenta nueva)                                            -> /primeros-pasos
//
// IMPORTANTE: no llama a gestionarAlertas (alert_manager). Esa funcion marca las alertas como "ya
// emitidas" y la pantalla /alertas se veria vacia. Aca solo se usan los calculos y un registro propio.
// Reglas: solo entre las 08:00 y las 22:30 (hora de Argentina); maximo 8 avisos por dia por dueño;
// nunca el mismo aviso dos veces; sin acusaciones ni nombres de empleados: "no cuadra con lo habitual".
// Lo dispara un servicio externo (cada hora) llamando a POST /api/job/vigilante con la clave interna.

const https = require('https');
const pool = require('./db');

const OFFSET_MS = 3 * 60 * 60 * 1000;           // Argentina = UTC-3 (sin horario de verano)
const FL = `(fecha - INTERVAL '3 hours')`;       // mismo criterio que prediccion_adaptativa
const MAX_AVISOS_DIA = 8;
const MAX_AVISOS_CORRIDA = 3;                    // si se juntan varios, salen de a 3 por hora (lo mas urgente primero)
const HORA_DESDE = 8;
const HORA_HASTA = 22.5;
const DIAS_VENTANA = 45;
const MIN_DIAS_HISTORIAL = 8;
const BASE_URL = process.env.FRONTEND_URL || 'https://lumo-psi.vercel.app';

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const TURNOS_ES = { manana: 'mañana', tarde: 'tarde', noche: 'noche' };

// Si el dueño no tocó el interruptor, estos avisos van encendidos (el resumen diario incluido).
const DEFAULTS_PREF = { alertas_criticas: true, alertas_medias: true, resumen_diario: true };

// ─── Utilidades ─────────────────────────────────────────────────────────────

function mediana(v) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Cuentas de prueba (test@test.com, example.com): no se les escribe, para no dañar la reputacion del correo.
function esCorreoDePrueba(email) {
  return /@(test\.com|example\.com|example\.org|test\.test)$/i.test(String(email || '').trim());
}

function pesos(n) {
  return '$' + Math.round(n).toLocaleString('es-AR');
}

function relojAR(ahora) {
  const l = new Date(ahora.getTime() - OFFSET_MS);
  return {
    hoy: l.toISOString().slice(0, 10),
    hora: l.getUTCHours() + l.getUTCMinutes() / 60,
    dow: l.getUTCDay(),
  };
}

function diasEntre(a, b) { // b - a en dias, con fechas 'YYYY-MM-DD'
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function dowDe(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }

function preferenciaActiva(config, tipoPref) {
  const c = config || {};
  const v = c[tipoPref];
  return v === undefined || v === null ? DEFAULTS_PREF[tipoPref] !== false : !!v;
}


// ─── Clima (Open-Meteo, gratis) ──────────────────────────────────────────────

const _cacheClima = {};
function pedirClima(lat, lon) {
  const key = lat.toFixed(2) + '_' + lon.toFixed(2);
  const c = _cacheClima[key];
  if (c && Date.now() - c.ts < 30 * 60 * 1000) return Promise.resolve(c.v);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=precipitation&daily=precipitation_sum,temperature_2m_max,temperature_2m_min` +
      `&forecast_days=1&timezone=America%2FArgentina%2FBuenos_Aires`;
    https.get(url, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => {
        clearTimeout(t);
        try {
          const j = JSON.parse(d);
          const v = {
            precip_hoy_mm: Number(j.daily.precipitation_sum[0] || 0),
            tmax: Number(j.daily.temperature_2m_max[0]),
            tmin: Number(j.daily.temperature_2m_min[0]),
            horas: (j.hourly.precipitation || []).map((x) => Number(x || 0)),
          };
          _cacheClima[key] = { ts: Date.now(), v };
          resolve(v);
        } catch { resolve(null); }
      });
    }).on('error', () => { clearTimeout(t); resolve(null); });
  });
}

async function sucursalConCoordenadas(db, usuarioId) {
  const r = await db.query(
    `SELECT id, latitud, longitud FROM mis_sucursales
     WHERE usuario_id = $1 AND COALESCE(activo, true) AND latitud IS NOT NULL AND longitud IS NOT NULL
     ORDER BY id LIMIT 1`, [usuarioId]);
  return r.rows[0] || null;
}

// Clima de hoy en la sucursal del dueño. Sin sucursal con coordenadas: no se inventa nada (null).
async function climaDe(db, p) {
  if (p._clima !== undefined) return p._clima;
  p._clima = null;
  try {
    const s = await sucursalConCoordenadas(db, p.usuarioId);
    if (s) {
      const c = await p.opts.clima(Number(s.latitud), Number(s.longitud));
      if (c) p._clima = { ...c, sucursal_id: s.id };
    }
  } catch (e) { /* sin clima: los avisos de clima se callan */ }
  return p._clima;
}

// Cuanto cambia la venta en dias de lluvia, MEDIDO en los datos del propio negocio.
// Necesita al menos 4 dias de lluvia con ventas en clima_historico. Si no, devuelve null (no se inventa).
async function efectoLluvia(db, p, sucursalId) {
  try {
    const desde = new Date(Date.parse(p.reloj.hoy + 'T12:00:00Z') - DIAS_VENTANA * 86400000).toISOString().slice(0, 10);
    const r = await db.query(
      `SELECT to_char(fecha,'YYYY-MM-DD') AS dia, clima FROM clima_historico WHERE sucursal_id = $1 AND fecha >= $2::date`,
      [sucursalId, desde]);
    const lluvia = new Set(r.rows.filter((x) => x.clima === 'lluvia').map((x) => x.dia));
    const hist = p.dias.filter((d) => d.dia < p.reloj.hoy);
    // el dia "normal" se mide solo con dias SIN lluvia, para no diluir el efecto
    const porDow = {};
    for (const d of hist) if (!lluvia.has(d.dia)) (porDow[dowDe(d.dia)] ||= []).push(d.total);
    const ratios = [];
    for (const d of hist) {
      if (!lluvia.has(d.dia)) continue;
      const base = porDow[dowDe(d.dia)] || [];
      if (base.length < 3) continue;
      const m = mediana(base);
      if (m > 0) ratios.push(d.total / m);
    }
    if (ratios.length < 4) return null;
    return { pct: Math.round((mediana(ratios) - 1) * 100), dias: ratios.length };
  } catch { return null; }
}

function frase_lluvia(ef) {
  if (!ef) return 'Todavía no tenemos suficientes días de lluvia en tu historial para medir cuánto te afecta. NICOLE lo va aprendiendo.';
  if (Math.abs(ef.pct) < 8) return `En tus ${ef.dias} días de lluvia anteriores la venta no cambió de forma marcada.`;
  return `En tus ${ef.dias} días de lluvia anteriores vendiste ${Math.abs(ef.pct)}% ${ef.pct > 0 ? 'más' : 'menos'} que un día normal.`;
}

// ─── Calendario ──────────────────────────────────────────────────────────────

function contextoDia(iso, opts) {
  const dia = Number(iso.slice(8, 10));
  let feriado = !!(opts && opts.feriados && opts.feriados.has(iso));
  try { if (!feriado) feriado = require('./zscore_contextual').FERIADOS_ARG.has(iso); } catch { /* sin tabla de feriados */ }
  return { feriado, cobro: [1, 5, 15, 30].includes(dia), fin_quincena: dia >= 26 };
}

// ─── Fuentes de NICOLE (los mismos calculos que muestran las pantallas) ───────

const FUENTES = {
  analizar: (negocioId) => require('./motor').analizarNegocio(negocioId, null),
  erm: (negocioId) => require('./erm').calcularERMNegocio(negocioId, null),
  rentabilidad: (negocioId) => require('./rentabilidad').calcularRentabilidad(negocioId, null),
  prediccion: (negocioId) => require('./prediccion_adaptativa').calcularPrediccion(negocioId, null, undefined, null, { incluirHoy: true, guardar: false }),
};

async function fuente(p, nombre) {
  p._f = p._f || {};
  if (p._f[nombre] !== undefined) return p._f[nombre];
  p._f[nombre] = null;
  try {
    const fn = (p.opts.fuentes && p.opts.fuentes[nombre]) || FUENTES[nombre];
    p._f[nombre] = await fn(p.negocioId);
  } catch (e) { console.error('[VIGILANTE] fuente', nombre, 'negocio', p.negocioId, e.message); }
  return p._f[nombre];
}

function recorte(s, n = 260) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function semanaDe(iso) { return Math.floor(Date.parse(iso + 'T00:00:00Z') / (7 * 86400000)); }

// Venta acumulada de un dia normal (mismo dia de la semana) hasta la hora actual.
async function acumuladoTipico(db, p) {
  const { reloj, negocioId, usuarioId, dias } = p;
  const mismos = dias.filter((d) => d.dia < reloj.hoy && dowDe(d.dia) === reloj.dow);
  if (mismos.length < 3) return null;
  const corte = Math.floor(reloj.hora);
  const r = await db.query(
    `SELECT to_char(${FL}::date,'YYYY-MM-DD') AS dia, SUM(monto)::float AS total
     FROM transacciones
     WHERE ${COND_NEG} AND ${FL}::date >= $3::date AND ${FL}::date < $4::date
       AND EXTRACT(HOUR FROM ${FL}) < $5
     GROUP BY 1`,
    [negocioId, usuarioId, mismos.map((d) => d.dia).sort()[0], reloj.hoy, corte]);
  const v = r.rows.filter((x) => dowDe(x.dia) === reloj.dow).map((x) => Number(x.total));
  return v.length >= 3 ? { tipico: mediana(v), n: v.length } : null;
}

// ─── Tabla propia (registro de avisos enviados) ──────────────────────────────

async function asegurarTabla(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS vigilante_envios(
    id SERIAL PRIMARY KEY,
    negocio_id INTEGER,
    usuario_id INTEGER,
    tipo VARCHAR(50) NOT NULL,
    contexto VARCHAR(120) NOT NULL DEFAULT '',
    titulo TEXT,
    canales TEXT,
    creado TIMESTAMP DEFAULT NOW()
  )`);
}

// ─── Datos de un negocio ─────────────────────────────────────────────────────

const COND_NEG = `(negocio_id = $1 OR (negocio_id IS NULL AND usuario_id = $2))
                  AND COALESCE(origin,'real') IN ('real','importado')`;

async function ventasPorDia(db, negocioId, usuarioId, desde) {
  const r = await db.query(
    `SELECT to_char(${FL}::date,'YYYY-MM-DD') AS dia,
            MIN(EXTRACT(HOUR FROM ${FL}))::int AS primera_hora,
            COUNT(*)::int AS n, SUM(monto)::float AS total
     FROM transacciones
     WHERE ${COND_NEG} AND ${FL}::date >= $3::date
     GROUP BY 1`,
    [negocioId, usuarioId, desde]
  );
  return r.rows.map((x) => ({ dia: x.dia, primera_hora: x.primera_hora, n: x.n, total: Number(x.total) }));
}

// ─── Detectores ─────────────────────────────────────────────────────────────
// Cada uno devuelve un arreglo de avisos: { tipo, contexto, pref, prioridad, titulo, mensaje, url, boton }

async function detSinDatos(db, p) {
  const { u, reloj } = p;
  if (p.totalVentas > 0) return [];
  if (reloj.hora < 10 || reloj.hora > 20) return [];
  const creado = u.created_at ? new Date(u.created_at) : null;
  if (!creado) return [];
  const dias = diasEntre(new Date(creado.getTime() - OFFSET_MS).toISOString().slice(0, 10), reloj.hoy);
  const etapa = dias >= 6 ? 3 : dias >= 3 ? 2 : dias >= 1 ? 1 : 0;
  if (!etapa) return [];
  const textos = {
    1: 'Todavía no cargaste ventas. En dos minutos podés subir un Excel, un PDF o una foto de tu cuaderno y te mostramos lo primero que vemos en tu negocio.',
    2: 'Tu cuenta sigue sin ventas. Con 10 ventas en 3 días distintos ya encontramos diferencias entre días, medios de pago y horarios. Subí lo que tengas, aunque sea desordenado.',
    3: 'Pasaron varios días y NICOLE todavía no tiene datos para trabajar. Subí tus ventas o conectá Mercado Pago y vemos qué está pasando en tu negocio.',
  };
  return [{
    tipo: 'sin_datos', contexto: 'etapa-' + etapa, pref: 'alertas_medias', prioridad: 6,
    titulo: 'Cargá tus ventas y empezamos', mensaje: textos[etapa],
    url: '/primeros-pasos', boton: 'Cargar ventas',
  }];
}

async function detDatosViejos(db, p) {
  const { reloj, dias } = p;
  if (!dias.length || reloj.hora < 10 || reloj.hora > 20) return [];
  const ultimo = dias.map((d) => d.dia).sort().slice(-1)[0];
  const atraso = diasEntre(ultimo, reloj.hoy);
  if (atraso <= 3) return [];
  return [{
    tipo: 'datos_desactualizados', contexto: 'ultima-' + ultimo, pref: 'alertas_medias', prioridad: 5,
    titulo: 'Tus datos están desactualizados',
    mensaje: `La última venta cargada es del ${ultimo.split('-').reverse().join('/')}, hace ${atraso} días. Sin ventas al día, NICOLE no puede avisarte nada de hoy. Subí lo que falta o conectá Mercado Pago para que se actualice solo.`,
    url: '/primeros-pasos', boton: 'Actualizar ventas',
  }];
}

async function detSinVentasHoy(db, p) {
  const { reloj, dias, negocioId, usuarioId } = p;
  const hist = dias.filter((d) => d.dia < reloj.hoy);
  if (hist.length < MIN_DIAS_HISTORIAL) return [];
  const ultimo = hist.map((d) => d.dia).sort().slice(-1)[0];
  if (diasEntre(ultimo, reloj.hoy) > 3) return [];           // datos no vivos: lo cubre datos_desactualizados
  if (dias.some((d) => d.dia === reloj.hoy)) return [];        // ya hay ventas hoy
  const mismoDow = hist.filter((d) => dowDe(d.dia) === reloj.dow);
  if (mismoDow.length < 2) return [];                          // ese dia de la semana casi nunca se vende
  const primera = mediana(hist.map((d) => d.primera_hora));
  const horaAviso = Math.min(20, Math.max(12, primera + 3));
  if (reloj.hora < horaAviso || reloj.hora > 21) return [];
  const corte = Math.floor(reloj.hora);
  const r = await db.query(
    `SELECT to_char(${FL}::date,'YYYY-MM-DD') AS dia, SUM(monto)::float AS total
     FROM transacciones
     WHERE ${COND_NEG} AND ${FL}::date >= $3::date AND ${FL}::date < $4::date
       AND EXTRACT(HOUR FROM ${FL}) < $5
     GROUP BY 1`,
    [negocioId, usuarioId, mismoDow.map((d) => d.dia).sort()[0], reloj.hoy, corte]
  );
  const acum = r.rows.filter((x) => dowDe(x.dia) === reloj.dow).map((x) => Number(x.total));
  const tipico = mediana(acum);
  const dia = DIAS_ES[reloj.dow];
  const frase = tipico && tipico > 0
    ? `Un ${dia} normal, a esta hora ya llevabas unos ${pesos(tipico)}.`
    : `Un ${dia} normal ya hay ventas a esta hora.`;
  return [{
    tipo: 'sin_ventas_hoy', contexto: reloj.hoy, pref: 'alertas_medias', prioridad: 2,
    titulo: 'Hoy todavía no hay ventas',
    mensaje: `${frase} No encontramos ventas de hoy. Puede que el local no haya abierto, o que algo no se esté registrando. Si abrió, conviene revisar la caja y el sistema de cobro.`,
    url: '/', boton: 'Ver mi negocio',
  }];
}

async function detTurnoSinAbrir(db, p) {
  const { reloj, negocioId } = p;
  const r = await db.query(
    `SELECT tipo_turno,
            to_char(hora_apertura - INTERVAL '3 hours','YYYY-MM-DD') AS dia,
            EXTRACT(HOUR FROM (hora_apertura - INTERVAL '3 hours'))::float
              + EXTRACT(MINUTE FROM (hora_apertura - INTERVAL '3 hours'))::float / 60 AS hora
     FROM turnos_caja
     WHERE negocio_id = $1 AND hora_apertura >= NOW() - INTERVAL '35 days'`,
    [negocioId]
  );
  const porTipo = {};
  for (const t of r.rows) { (porTipo[t.tipo_turno] ||= []).push({ dia: t.dia, hora: Number(t.hora) }); }
  const avisos = [];
  for (const [tipo, lista] of Object.entries(porTipo)) {
    if (lista.some((t) => t.dia === reloj.hoy)) continue;       // hoy ya se abrio
    const mismos = lista.filter((t) => t.dia < reloj.hoy && dowDe(t.dia) === reloj.dow);
    const diasDistintos = new Set(mismos.map((t) => t.dia)).size;
    if (diasDistintos < 3) continue;                              // no es un turno habitual de este dia
    const habitual = mediana(mismos.map((t) => t.hora));
    if (reloj.hora < habitual + 1.5 || reloj.hora > habitual + 6) continue;
    const hh = String(Math.floor(habitual)).padStart(2, '0') + ':' + String(Math.round((habitual % 1) * 60)).padStart(2, '0');
    avisos.push({
      tipo: 'turno_sin_abrir', contexto: `${tipo}-${reloj.hoy}`, pref: 'alertas_medias', prioridad: 1,
      titulo: `El turno ${TURNOS_ES[tipo] || tipo} no se abrió`,
      mensaje: `Un ${DIAS_ES[reloj.dow]} el turno ${TURNOS_ES[tipo] || tipo} se abre alrededor de las ${hh}, y hoy todavía no hay uno abierto. Sin turno no hay control de caja. Confirmá con tu equipo si hoy se trabaja.`,
      url: '/empleado', boton: 'Ver turnos',
    });
  }
  return avisos;
}

async function detCajaAbierta(db, p) {
  const { negocioId, ahora } = p;
  const r = await db.query(
    `SELECT id, nombre_empleado, tipo_turno,
            ROUND(EXTRACT(EPOCH FROM (($2::timestamptz AT TIME ZONE 'UTC') - hora_apertura)) / 3600)::int AS horas
     FROM turnos_caja
     WHERE negocio_id = $1 AND estado = 'activo'
       AND hora_apertura < ($2::timestamptz AT TIME ZONE 'UTC') - INTERVAL '14 hours'
       AND hora_apertura > ($2::timestamptz AT TIME ZONE 'UTC') - INTERVAL '4 days'`,
    [negocioId, ahora.toISOString()]
  );
  return r.rows.map((t) => ({
    tipo: 'caja_abierta_larga', contexto: 'turno-' + t.id, pref: 'alertas_medias', prioridad: 3,
    titulo: 'Hay un turno abierto hace muchas horas',
    mensaje: `El turno ${TURNOS_ES[t.tipo_turno] || t.tipo_turno} de ${t.nombre_empleado} lleva ${t.horas} horas abierto. Puede que se haya olvidado de cerrarlo. Mientras siga abierto, la caja de ese turno no se puede controlar.`,
    url: '/empleado', boton: 'Revisar turno',
  }));
}

async function detResumenDiario(db, p) {
  const { reloj, dias } = p;
  if (reloj.hora < 21 || reloj.hora >= HORA_HASTA) return [];
  const hoyD = dias.find((d) => d.dia === reloj.hoy);
  if (!hoyD) return [];
  const tipicos = dias.filter((d) => d.dia < reloj.hoy && dowDe(d.dia) === reloj.dow).map((d) => d.total);
  let cierre = `Hoy vendiste ${pesos(hoyD.total)} en ${hoyD.n} ventas.`;
  if (tipicos.length >= 3) {
    const t = mediana(tipicos);
    if (t > 0) {
      const dif = Math.round((hoyD.total / t - 1) * 100);
      cierre += Math.abs(dif) < 5
        ? ` Fue un ${DIAS_ES[reloj.dow]} en línea con lo normal (${pesos(t)}).`
        : ` Un ${DIAS_ES[reloj.dow]} normal vendés ${pesos(t)}: hoy fue ${Math.abs(dif)}% ${dif > 0 ? 'más' : 'menos'}.`;
    }
  }
  const previos = dias.filter((d) => d.dia < reloj.hoy).map((d) => d.total);
  if (previos.length >= 15 && hoyD.total > Math.max(...previos)) cierre += ` Fue tu mejor día de los últimos ${previos.length + 1}.`;
  return [{
    tipo: 'resumen_diario', contexto: reloj.hoy, pref: 'resumen_diario', prioridad: 7,
    titulo: 'Cierre del día', mensaje: cierre, url: '/', boton: 'Ver mi negocio',
  }];
}


// ── Resumen y ritmo del dia ──

async function detBriefing(db, p) {
  const { reloj, dias, u } = p;
  if (reloj.hora < 8 || reloj.hora >= 11) return [];
  const hist = dias.filter((d) => d.dia < reloj.hoy);
  if (hist.length < MIN_DIAS_HISTORIAL) return [];
  const ultimo = hist.map((d) => d.dia).sort().slice(-1)[0];
  if (diasEntre(ultimo, reloj.hoy) > 3) return [];             // datos no vivos: lo cubre datos_desactualizados
  const partes = [];
  const nombre = String(u.nombre || '').trim().split(/\s+/)[0];
  const dia = DIAS_ES[reloj.dow];

  // Que se espera hoy: prediccion de NICOLE; si no hay, un dia normal
  let esperado = null, rango = null;
  const pred = await fuente(p, 'prediccion');
  if (pred && pred.disponible && Array.isArray(pred.predicciones)) {
    const hoyP = pred.predicciones.find((x) => x.fecha_target === reloj.hoy) || null;
    if (hoyP && Number(hoyP.valor_predicho) > 0) {
      esperado = Number(hoyP.valor_predicho);
      if (hoyP.rango_min && hoyP.rango_max) rango = [Number(hoyP.rango_min), Number(hoyP.rango_max)];
    }
  }
  if (esperado == null) {
    const t = hist.filter((d) => dowDe(d.dia) === reloj.dow).map((d) => d.total);
    if (t.length >= 3) esperado = mediana(t);
  }
  if (esperado != null) {
    partes.push(`Hoy ${dia} NICOLE espera unos ${pesos(esperado)}` + (rango ? ` (entre ${pesos(rango[0])} y ${pesos(rango[1])}).` : '.'));
  }

  // Contexto del dia: feriado, cobro, fin de quincena
  const ctx = contextoDia(reloj.hoy, p.opts);
  if (ctx.feriado) partes.push('Es feriado: se vende distinto a un día común.');
  else if (ctx.cobro) partes.push('Es día de cobro: suele haber más movimiento.');
  else if (ctx.fin_quincena) partes.push('Estamos a fin de mes: suele haber menos movimiento.');

  // Clima
  const cl = await climaDe(db, p);
  if (cl) {
    if (cl.precip_hoy_mm >= 2) {
      partes.push(`Se espera lluvia hoy (${Math.round(cl.precip_hoy_mm)} mm). ` + frase_lluvia(await efectoLluvia(db, p, cl.sucursal_id)));
    } else if (cl.tmax >= 33) partes.push(`Hoy hace mucho calor (máxima de ${Math.round(cl.tmax)}°).`);
    else if (cl.tmax <= 8) partes.push(`Hoy hace mucho frío (máxima de ${Math.round(cl.tmax)}°).`);
  }
  if (!partes.length) return [];
  return [{
    tipo: 'briefing_matutino', contexto: reloj.hoy, pref: 'resumen_diario', prioridad: 4,
    titulo: nombre ? `Buen día, ${nombre}: así viene hoy` : 'Buen día: así viene hoy',
    mensaje: partes.join(' '), url: '/predicciones', boton: 'Ver predicciones',
  }];
}

async function detLluvia(db, p) {
  const { reloj } = p;
  if (reloj.hora < 8 || reloj.hora >= 21) return [];
  const cl = await climaDe(db, p);
  if (!cl || !Array.isArray(cl.horas) || cl.horas.length < 24) return [];
  const h = Math.floor(reloj.hora);
  const ahoraMm = cl.horas[h] || 0;
  const proximas = (cl.horas[h + 1] || 0) + (cl.horas[h + 2] || 0) + (cl.horas[h + 3] || 0);
  let titulo = null;
  if (ahoraMm >= 0.5) titulo = 'Está lloviendo en tu zona';
  else if (proximas >= 1.5) titulo = 'Va a empezar a llover en las próximas horas';
  if (!titulo) return [];
  const ef = await efectoLluvia(db, p, cl.sucursal_id);
  const accion = ef && ef.pct <= -8 ? ' Conviene reforzar pedidos por delivery y cobros digitales.'
    : ef && ef.pct >= 8 ? ' Revisá que tengas stock para un día más movido.' : '';
  return [{
    tipo: 'lluvia', contexto: reloj.hoy, pref: 'alertas_medias', prioridad: 3, titulo,
    mensaje: frase_lluvia(ef) + accion, url: '/predicciones', boton: 'Ver predicciones',
  }];
}

async function detRitmo(db, p) {
  const { reloj, dias } = p;
  if (reloj.hora < 12 || reloj.hora > 21) return [];
  const hoyD = dias.find((d) => d.dia === reloj.hoy);
  if (!hoyD || !(hoyD.total > 0)) return [];                       // sin ventas hoy lo cubre sin_ventas_hoy
  const t = await acumuladoTipico(db, p);
  if (!t || !(t.tipico > 0)) return [];
  const ratio = hoyD.total / t.tipico;
  const dia = DIAS_ES[reloj.dow];
  if (ratio <= 0.6) {
    return [{
      tipo: 'ritmo_bajo', contexto: reloj.hoy, pref: 'alertas_medias', prioridad: 2,
      titulo: 'Hoy vas más flojo de lo normal',
      mensaje: `Llevás ${pesos(hoyD.total)} y un ${dia} normal, a esta hora, llevás unos ${pesos(t.tipico)}: ${Math.round((1 - ratio) * 100)}% menos. Fijate si hay algo puntual (clima, falta de personal, stock) o si falta cargar ventas.`,
      url: '/', boton: 'Ver mi negocio',
    }];
  }
  if (ratio >= 1.4) {
    return [{
      tipo: 'ritmo_alto', contexto: reloj.hoy, pref: 'alertas_medias', prioridad: 6,
      titulo: 'Hoy viene fuerte',
      mensaje: `Llevás ${pesos(hoyD.total)} y un ${dia} normal, a esta hora, llevás unos ${pesos(t.tipico)}: ${Math.round((ratio - 1) * 100)}% más. Revisá que tengas stock y personal para lo que queda del día.`,
      url: '/', boton: 'Ver mi negocio',
    }];
  }
  return [];
}

// ── Lo que NICOLE detecta (mismos calculos que muestran las pantallas) ──

// Las señales de NICOLE traen el mensaje como objeto { descripcion, contexto, accion_recomendada }
// (a veces como texto). Se arma un texto corto y nunca se deja pasar "[object Object]".
function textoDe(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') return String(x.descripcion || x.texto_completo || x.mensaje || x.titulo || '');
  return '';
}
function textoSenal(s) {
  const base = textoDe(s.mensaje) || textoDe(s.insight);
  if (!base) return '';
  const accion = textoDe(s.accion) || textoDe(s.mensaje && s.mensaje.accion_recomendada) || textoDe(s.insight && s.insight.accion_recomendada);
  const t = [base, accion].filter(Boolean).join(' ');
  return t.includes('[object') ? '' : t;
}

async function detNicole(db, p) {
  const { reloj } = p;
  if (reloj.hora < 8 || reloj.hora >= HORA_HASTA || p.totalVentas < 10) return [];
  const a = await fuente(p, 'analizar');
  if (!a || a.error || !Array.isArray(a.señales)) return [];
  const MAPA = {
    critico:        { pref: 'alertas_criticas', prioridad: 0, titulo: 'NICOLE detectó una inconsistencia operativa' },
    inconsistencia: { pref: 'alertas_criticas', prioridad: 0, titulo: 'NICOLE detectó una inconsistencia operativa' },
    atencion:       { pref: 'alertas_medias',   prioridad: 3, titulo: 'NICOLE encontró algo para revisar' },
    ineficiencia:   { pref: 'alertas_medias',   prioridad: 3, titulo: 'NICOLE encontró algo para mejorar' },
    positivo:       { pref: 'alertas_medias',   prioridad: 8, titulo: 'Buena noticia en tu negocio' },
  };
  const out = [];
  for (const s of a.señales) {
    const m = MAPA[s.prioridad];
    const texto = recorte(textoSenal(s));
    if (!m || !texto) continue;
    out.push({
      tipo: 'nicole_senal', contexto: recorte(`${s.tipo || 'senal'}-${s.contexto || s.turno || ''}-${reloj.hoy}`, 110),
      pref: m.pref, prioridad: m.prioridad, titulo: m.titulo, mensaje: texto, url: '/alertas', boton: 'Ver alertas',
    });
  }
  return out.sort((x, y) => x.prioridad - y.prioridad).slice(0, 2);
}

async function detERM(db, p) {
  const { reloj } = p;
  if (reloj.hora < 9 || reloj.hora >= 21) return [];
  const e = await fuente(p, 'erm');
  if (!e || !e.resumen) return [];
  const sem = semanaDe(reloj.hoy);
  const r = e.resumen;
  if (r.rojos > 0) {
    return [{
      tipo: 'erm_rojo', contexto: `rojos-${r.rojos}-${sem}`, pref: 'alertas_criticas', prioridad: 1,
      titulo: r.rojos === 1 ? 'Hay señales repetidas en el turno de una persona del equipo' : `Hay señales repetidas en el turno de ${r.rojos} personas del equipo`,
      mensaje: 'NICOLE ve diferencias de caja que se repiten (nivel rojo). No es una acusación: es una inconsistencia operativa que conviene revisar con el detalle antes de hablar con nadie.' + (e.alerta_equipo ? ' ' + e.alerta_equipo + '.' : ''),
      url: '/empleados', boton: 'Ver equipo',
    }];
  }
  if (r.amarillos > 0) {
    return [{
      tipo: 'erm_amarillo', contexto: `amarillos-${r.amarillos}-${sem}`, pref: 'alertas_medias', prioridad: 4,
      titulo: 'Hay señales para mirar en el equipo',
      mensaje: `NICOLE ve señales leves en ${r.amarillos === 1 ? 'una persona' : r.amarillos + ' personas'} del equipo (nivel amarillo). Todavía no es nada grave: conviene seguirlo estos días.`,
      url: '/empleados', boton: 'Ver equipo',
    }];
  }
  return [];
}

async function detRentabilidad(db, p) {
  const { reloj, dias } = p;
  if (reloj.hora < 10 || reloj.hora >= 20) return [];
  const rr = await fuente(p, 'rentabilidad');
  if (!rr) return [];
  if (rr.hay_gastos === false) {
    if (dias.length < 20) return [];
    return [{
      tipo: 'gastos_sin_cargar', contexto: 'semana-' + semanaDe(reloj.hoy), pref: 'alertas_medias', prioridad: 5,
      titulo: 'Cargá tus gastos y vemos si estás ganando plata',
      mensaje: 'Ya tenemos tus ventas, pero faltan tus gastos del mes (alquiler, sueldos, mercadería). Con eso NICOLE te dice tu ganancia real y cuánto tenés que vender por día para cubrir todo.',
      url: '/rentabilidad', boton: 'Cargar gastos',
    }];
  }
  const TIPO = { alerta: { prioridad: 2, pref: 'alertas_criticas' }, atencion: { prioridad: 4, pref: 'alertas_medias' }, positiva: { prioridad: 8, pref: 'alertas_medias' } };
  const out = [];
  for (const rec of (rr.recomendaciones || [])) {
    const m = TIPO[rec.tipo];
    if (!m || !rec.id || !rec.titulo) continue;
    // Lo que cuesta plata ya sale como FUGA (detFugas): aca solo quedan las buenas noticias y lo que no tiene monto
    if (rec.tipo !== 'positiva' && Number(rec.impacto_pesos) > 0) continue;
    out.push({
      tipo: 'rentabilidad', contexto: recorte(rec.id, 110), pref: m.pref, prioridad: m.prioridad,
      titulo: recorte(rec.titulo, 110), mensaje: recorte([rec.detalle, rec.accion].filter(Boolean).join(' ')),
      url: '/rentabilidad', boton: 'Ver rentabilidad',
    });
  }
  return out.slice(0, 2);
}

// Fugas de plata (caja + rentabilidad): cada fuga ACTIVA llega como aviso y abre esa fuga en /fugas.
// No avisa las que ya estan "en seguimiento", "resueltas" o "descartadas", ni las que estan incluidas en otra
// fuga (ej. la suba de mercaderia ya esta dentro de "precios atrasados"): asi no se repite lo mismo dos veces.
async function detFugas(db, p) {
  const { reloj } = p;
  if (reloj.hora < 9 || reloj.hora >= 20) return [];
  let r = null;
  try {
    const fn = (p.opts.fuentes && p.opts.fuentes.fugas) || (() => require('./fugas').calcularFugas(p.negocioId, db, {
      ahora: p.opts.ahora,
      fuentes: { rentabilidad: () => fuente(p, 'rentabilidad') },
    }));
    r = await fn(p.negocioId);
  } catch (e) { console.error('[VIGILANTE] fugas negocio', p.negocioId, e.message); return []; }
  if (!r || !Array.isArray(r.fugas)) return [];
  const out = [];
  for (const f of r.fugas.filter((x) => x.estado === 'activa' && x.incluida_en !== 'precios' && x.monto > 0).sort((a, b) => b.monto - a.monto)) {
    const caja = f.fuente === 'caja';
    out.push({
      tipo: 'fuga', contexto: recorte(f.id + (caja ? '|s' + semanaDe(reloj.hoy) : ''), 110),
      pref: caja ? 'alertas_criticas' : 'alertas_medias', prioridad: caja ? 2 : 3,
      titulo: recorte(f.titulo, 110),
      mensaje: recorte((String(f.titulo).includes(pesos(f.monto)) ? '' : pesos(f.monto) + ' en los ' + String(f.periodo || '') + '. ') + (f.evidencia[0] || '') + ' Cómo cerrarla: ' + (f.como_corregir[0] || '')),
      url: '/fugas?id=' + encodeURIComponent(f.id), boton: 'Ver la fuga',
    });
  }
  return out.slice(0, 2);
}

const DETECTORES = [detTurnoSinAbrir, detCajaAbierta, detSinVentasHoy, detRitmo, detNicole, detERM, detLluvia, detFugas, detRentabilidad, detBriefing, detDatosViejos, detSinDatos, detResumenDiario];

// ─── Un negocio ─────────────────────────────────────────────────────────────

async function yaEnviado(db, negocioId, tipo, contexto) {
  const r = await db.query(
    `SELECT 1 FROM vigilante_envios WHERE negocio_id=$1 AND tipo=$2 AND contexto=$3 LIMIT 1`,
    [negocioId, tipo, contexto]
  );
  return r.rows.length > 0;
}

async function enviadosHoy(db, usuarioId, hoy) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM vigilante_envios
     WHERE usuario_id=$1 AND (creado - INTERVAL '3 hours')::date = $2::date`,
    [usuarioId, hoy]
  );
  return r.rows[0].n;
}

async function procesarNegocio(db, u, ahora, reloj, opts) {
  const negocioId = u.negocio_id;
  const usuarioId = u.usuario_id;
  const desde = new Date(ahora.getTime() - OFFSET_MS - DIAS_VENTANA * 86400000).toISOString().slice(0, 10);
  const dias = await ventasPorDia(db, negocioId, usuarioId, desde);
  const tot = await db.query(
    `SELECT COUNT(*)::int AS n FROM transacciones WHERE ${COND_NEG}`, [negocioId, usuarioId]
  );
  const p = { u, reloj, ahora, dias, negocioId, usuarioId, opts, totalVentas: tot.rows[0].n };

  let candidatos = [];
  for (const det of DETECTORES) {
    try { candidatos = candidatos.concat(await det(db, p)); }
    catch (e) { console.error('[VIGILANTE]', det.name, 'negocio', negocioId, e.message); }
  }
  candidatos = candidatos.filter((a) => preferenciaActiva(u.notificaciones_config, a.pref));
  candidatos.sort((a, b) => a.prioridad - b.prioridad);

  const nuevos = [];
  for (const a of candidatos) {
    if (!(await yaEnviado(db, negocioId, a.tipo, a.contexto))) nuevos.push(a);
  }
  let cupo = MAX_AVISOS_DIA - (await enviadosHoy(db, usuarioId, reloj.hoy));
  const resultado = { negocio_id: negocioId, email: u.email, candidatos: nuevos.map((a) => a.tipo + ':' + a.contexto), enviados: [] };

  let enEstaCorrida = 0;
  for (const a of nuevos) {
    if (cupo <= 0 || enEstaCorrida >= MAX_AVISOS_CORRIDA) break;
    if (opts.dry) { resultado.enviados.push({ tipo: a.tipo, contexto: a.contexto, titulo: a.titulo, mensaje: a.mensaje, url: a.url, simulado: true }); cupo--; enEstaCorrida++; continue; }
    const canales = [];
    try {
      await opts.notificar(usuarioId, { title: a.titulo, body: a.mensaje, url: a.url }, db, a.pref);
      canales.push('push');
    } catch (e) { /* sin suscripcion o sin claves: seguimos con el email */ }
    try {
      const ok = await opts.email({
        nombre: u.nombre, email: u.email, negocio: u.negocio_nombre,
        titulo: a.titulo, mensaje: a.mensaje, url: BASE_URL + a.url, boton: a.boton,
      });
      if (ok) canales.push('email');
    } catch (e) { console.error('[VIGILANTE] email', e.message); }
    if (!canales.length) continue;                    // no llego por ningun lado: se reintenta en la proxima corrida
    await db.query(
      `INSERT INTO vigilante_envios(negocio_id, usuario_id, tipo, contexto, titulo, canales) VALUES($1,$2,$3,$4,$5,$6)`,
      [negocioId, usuarioId, a.tipo, a.contexto, a.titulo, canales.join(',')]
    );
    resultado.enviados.push({ tipo: a.tipo, contexto: a.contexto, canales });
    cupo--; enEstaCorrida++;
  }
  return resultado;
}

// ─── Corrida completa ────────────────────────────────────────────────────────
// opts: { dry, ahora (Date), notificar, email }  — todo opcional, para pruebas.

async function correrVigilante(db = pool, opts = {}) {
  const ahora = opts.ahora || new Date();
  const reloj = relojAR(ahora);
  const resumen = { ahora_ar: reloj, dry: !!opts.dry, negocios: 0, enviados: 0, detalle: [] };

  if (reloj.hora < HORA_DESDE || reloj.hora >= HORA_HASTA) {
    resumen.motivo = 'fuera_de_horario';
    return resumen;
  }
  const o = {
    dry: !!opts.dry,
    notificar: opts.notificar || require('./push').notificarUsuario,
    email: opts.email || require('./mailer').enviarAvisoVigilante,
    clima: opts.clima || pedirClima,
    fuentes: opts.fuentes || null,
    feriados: opts.feriados || null,
  };
  await asegurarTabla(db);
  const ng = await db.query(
    `SELECT n.id AS negocio_id, u.id AS usuario_id, u.nombre, u.email, u.negocio AS negocio_nombre,
            u.notificaciones_config, u.created_at
     FROM negocios n
     JOIN negocio_usuarios nu ON nu.negocio_id = n.id AND nu.rol = 'owner' AND nu.activo = true
     JOIN usuarios u ON u.id = nu.usuario_id
     WHERE n.deletion_scheduled_at IS NULL AND u.deletion_scheduled_at IS NULL
     ORDER BY n.id`
  );
  for (const u of ng.rows) {
    if (esCorreoDePrueba(u.email)) { resumen.omitidos_prueba = (resumen.omitidos_prueba || 0) + 1; continue; }
    resumen.negocios++;
    try {
      const r = await procesarNegocio(db, u, ahora, reloj, o);
      resumen.enviados += r.enviados.length;
      if (r.candidatos.length || r.enviados.length) resumen.detalle.push(r);
    } catch (e) {
      console.error('[VIGILANTE] negocio', u.negocio_id, e.message);
      resumen.detalle.push({ negocio_id: u.negocio_id, error: e.message });
    }
  }
  return resumen;
}

module.exports = { correrVigilante, relojAR, mediana, preferenciaActiva };
