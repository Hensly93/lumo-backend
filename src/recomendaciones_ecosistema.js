// recomendaciones_ecosistema.js — LumoBi · Recomendar v2 (28/10/2026)
//
// Recomendaciones precisas sobre todo el negocio. Cada una lleva:
//   dato propio + comparación + impacto en $ + acción exacta (sucursal, día, franja).
// Reglas fijas de NICOLE:
//   - Nunca se nombra a una persona: se habla de turno y sucursal (los nombres solo en Equipo).
//   - Nunca "fraude": "posible inconsistencia operativa".
//   - LumoBi sugiere, el dueño decide (no administra turnos ni stock).
//
// Áreas:
//   1. Controles de caja: faltantes recurrentes por turno/día/sucursal y conteos omitidos.
//   2. Caja: meta de cierre de mañana por sucursal y turno (predicción × % efectivo).
//   3. Predicción: delega en recomendaciones_prediccion.js.
// Las recomendaciones de control declaran `reemplaza` con las reglas viejas genéricas
// que dicen lo mismo, para no duplicar.

const pool = require('./db');
const { calcularPrediccion } = require('./prediccion_adaptativa');
const { recomendacionesDePrediccion } = require('./recomendaciones_prediccion');

const FL_AP = `(hora_apertura - INTERVAL '3 hours')`;
const DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIA_PL = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];

function fmt(n) { return '$' + Math.round(Math.abs(n)).toLocaleString('es-AR'); }
function hoyAR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function sumarDias(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dowDe(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
function fechaCorta(iso) { const [, m, d] = iso.split('-'); return `${Number(d)}/${Number(m)}`; }
function nombreTurno(t) { return t === 'manana' ? 'mañana' : t; }
function limpiarNombre(n) { return String(n || '').replace(/["']/g, '').trim(); }
function mediana(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function proximo(dow, desde) { for (let k = 1; k <= 7; k++) { const f = sumarDias(desde, k); if (dowDe(f) === dow) return f; } return null; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── 1. Controles de caja ─────────────────────────────────────────────────────
async function recomendacionesControl(negocioId, sucursalId, db, turnos, nombres) {
  const recs = [];
  const hoy = hoyAR();
  const cerrados = turnos.filter(t => t.estado === 'cerrado' && t.brecha != null);
  if (!cerrados.length) return { recs, patrones: [] };

  // Umbral de faltante: el mayor entre $1.000 y 3× el p75 de |brecha| del negocio.
  const abs = cerrados.map(t => Math.abs(t.brecha)).sort((a, b) => a - b);
  const p75 = abs[Math.floor(abs.length * 0.75)] || 0;
  const umbral = Math.max(1000, 3 * p75);

  // 1a. Faltantes recurrentes en el mismo turno + día de semana + sucursal (últimas 4 semanas)
  const desde28 = sumarDias(hoy, -28);
  const grupos = {};
  cerrados.filter(t => t.dia >= desde28).forEach(t => {
    const k = `${t.sucursal_id}|${t.tipo_turno}|${t.dow}`;
    (grupos[k] = grupos[k] || []).push(t);
  });
  const patrones = [];
  for (const [k, ts] of Object.entries(grupos)) {
    const falt = ts.filter(t => t.brecha >= umbral);
    if (falt.length < 3 || falt.length / ts.length < 0.5) continue;
    const [suc, tipo, dowS] = k.split('|');
    const dow = Number(dowS);
    const total = falt.reduce((a, t) => a + t.brecha, 0);
    // Comparación: el resto de los turnos de esa sucursal
    const resto = cerrados.filter(t => String(t.sucursal_id) === suc && t.dia >= desde28 && !(t.tipo_turno === tipo && t.dow === dow));
    const restoProm = resto.length ? resto.reduce((a, t) => a + Math.abs(t.brecha), 0) / resto.length : null;
    const h0 = mediana(ts.map(t => t.h_ap)), h1 = mediana(ts.map(t => t.h_ci));
    const sigue = proximo(dow, hoy);
    const nombreSuc = nombres[suc] || `sucursal ${suc}`;
    const franjaConteo = h1 != null ? `entre las ${Math.max(h0 ?? 0, h1 - 3)} y las ${h1 - 1} h` : 'en la segunda mitad del turno';
    patrones.push({ sucursal_id: Number(suc), tipo_turno: tipo, dow });
    recs.push({
      id: 'CONTROL_FALTANTE_RECURRENTE',
      categoria: 'inconsistencia_operativa',
      prioridad: falt.length >= 4 || total >= 10000 ? 'critica' : 'alta',
      mensaje: `Posible inconsistencia operativa: los ${DIA_PL[dow]} en el turno ${nombreTurno(tipo)} de ${nombreSuc}, ${falt.length} de ${ts.length} cierres tuvieron faltante ` +
        `(promedio ${fmt(total / falt.length)}, ${fmt(total)} en 4 semanas)` +
        (restoProm != null ? `. El resto de los turnos de ${nombreSuc} cierra con una diferencia promedio de ${fmt(restoProm)}.` : '.'),
      accion: `El ${DIA[dow]} ${sigue ? fechaCorta(sigue) : ''} hacé un conteo sorpresa en ese turno ${franjaConteo} y controlá el cierre ese mismo día. ` +
        `Si el conteo da bien y el cierre no, la diferencia aparece al final del turno.`,
      datos: { sucursal_id: Number(suc), tipo_turno: tipo, dia_semana: dow, faltantes: falt.length, turnos: ts.length,
               total_faltante: Math.round(total), umbral: Math.round(umbral), proxima_fecha: sigue },
      reemplaza: ['TURNO_INCONSISTENTE_SOSTENIDO', 'DIFERENCIA_ENTRE_TURNOS', 'BRECHA_CRECIENTE'],
    });
  }

  // 1b. Conteos sorpresa omitidos por turno + sucursal (últimas 2 semanas)
  const desde14 = sumarDias(hoy, -14);
  const gc = {};
  turnos.filter(t => t.dia >= desde14 && t.conteo_programado).forEach(t => {
    const k = `${t.sucursal_id}|${t.tipo_turno}`;
    (gc[k] = gc[k] || []).push(t);
  });
  const tasaResto = (k) => {
    const otros = Object.entries(gc).filter(([kk]) => kk !== k).flatMap(([, v]) => v);
    return otros.length ? otros.filter(t => t.omitido).length / otros.length : null;
  };
  const conConteosOmitidos = new Set();
  for (const [k, ts] of Object.entries(gc)) {
    const om = ts.filter(t => t.omitido).length;
    if (om < 3 || om / ts.length < 0.5) continue;
    conConteosOmitidos.add(k);
    const [suc, tipo] = k.split('|');
    const nombreSuc = nombres[suc] || `sucursal ${suc}`;
    const tr = tasaResto(k);
    recs.push({
      id: 'CONTROL_CONTEOS_OMITIDOS',
      categoria: 'inconsistencia_operativa',
      prioridad: 'alta',
      mensaje: `El turno ${nombreTurno(tipo)} de ${nombreSuc} no respondió ${om} de ${ts.length} conteos sorpresa en las últimas 2 semanas` +
        (tr != null ? ` (el resto de los turnos respondió el ${Math.round((1 - tr) * 100)}%).` : '.') +
        ' Sin esos conteos, NICOLE no puede ubicar en qué momento del turno aparece una diferencia.',
      accion: `Hablá con el equipo del turno ${nombreTurno(tipo)} de ${nombreSuc}: el conteo se responde apenas llega. ` +
        `Mientras tanto, contá vos la caja al cierre de ese turno los próximos días.`,
      datos: { sucursal_id: Number(suc), tipo_turno: tipo, omitidos: om, programados: ts.length },
      reemplaza: ['CONTEOS_OMITIDOS_FRECUENTES'],
    });
  }

  // 1c. Rachas positivas por turno + sucursal (reemplaza a la regla vieja, que mezclaba sucursales)
  const porTurno = {};
  cerrados.forEach(t => { const k = `${t.sucursal_id}|${t.tipo_turno}`; (porTurno[k] = porTurno[k] || []).push(t); });
  const rachas = [];
  for (const [k, ts] of Object.entries(porTurno)) {
    const ord = [...ts].sort((a, b) => (a.dia < b.dia ? 1 : -1));
    let n = 0;
    for (const t of ord) { if (Math.abs(t.brecha) >= umbral) break; n++; }
    if (n >= 14 && !conConteosOmitidos.has(k) && !patrones.some(x => `${x.sucursal_id}|${x.tipo_turno}` === k)) rachas.push({ k, n, total: ts.length });
  }
  rachas.sort((a, b) => b.n - a.n).slice(0, 2).forEach(({ k, n, total }) => {
    const [suc, tipo] = k.split('|');
    const nombreSuc = nombres[suc] || `sucursal ${suc}`;
    recs.push({
      id: 'CONTROL_RACHA_POSITIVA',
      categoria: 'positivo',
      prioridad: 'info',
      mensaje: `El turno ${nombreTurno(tipo)} de ${nombreSuc} lleva ${n} cierres seguidos sin diferencias mayores a ${fmt(umbral)}` +
        (n >= total ? ' (todos los de los últimos 60 días).' : '.'),
      accion: `Reconocé al equipo de ese turno: es tu turno de referencia. Su forma de abrir, contar y cerrar la caja sirve de estándar para el resto.`,
      datos: { sucursal_id: Number(suc), tipo_turno: tipo, racha: n },
      reemplaza: ['RACHA_POSITIVA_TURNO'],
    });
  });

  return { recs, patrones };
}

// ─── 2. Meta de cierre de caja de mañana ──────────────────────────────────────
async function recomendacionesCaja(negocioId, sucursalId, db, turnos, nombres, patrones, opciones) {
  const recs = [];
  const hoy = hoyAR();
  const manana = sumarDias(hoy, 1);
  const dowM = dowDe(manana);
  const desde30 = sumarDias(hoy, -30);

  // Turnos habituales por sucursal (últimos 30 días): horario y apertura típicos
  const porSuc = {};
  turnos.filter(t => t.dia >= desde30 && t.sucursal_id != null).forEach(t => {
    const s = (porSuc[t.sucursal_id] = porSuc[t.sucursal_id] || {});
    (s[t.tipo_turno] = s[t.tipo_turno] || []).push(t);
  });
  const sucs = Object.keys(porSuc).filter(s => sucursalId == null || Number(s) === sucursalId);
  if (!sucs.length) return recs;

  // % de efectivo por sucursal y hora (últimos 60 días)
  const efRes = await db.query(
    `SELECT sucursal_id, EXTRACT(HOUR FROM fecha - INTERVAL '3 hours')::int AS h,
            SUM(monto) AS total, SUM(monto) FILTER (WHERE lower(metodo_pago) = 'efectivo') AS efectivo
     FROM transacciones
     WHERE negocio_id = $1 AND fecha >= NOW() - INTERVAL '60 days' AND sucursal_id = ANY($2::int[])
     GROUP BY 1, 2`,
    [negocioId, sucs.map(Number)]
  );
  const porHora = {};
  efRes.rows.forEach(r => {
    const s = (porHora[r.sucursal_id] = porHora[r.sucursal_id] || {});
    s[r.h] = { total: parseFloat(r.total) || 0, efectivo: parseFloat(r.efectivo) || 0 };
  });

  for (const s of sucs) {
    const pred = await calcularPrediccion(negocioId, Number(s), db, null, { ...opciones, guardar: false });
    if (!pred.disponible) continue;
    const p = pred.predicciones.find(x => x.fecha_target === manana);
    if (!p) continue;
    const ph = porHora[s] || {};
    const totalDia = Object.values(ph).reduce((a, v) => a + v.total, 0);
    if (!totalDia) continue;
    const factorMin = p.rango_min && p.valor_predicho ? p.rango_min / p.valor_predicho : 0.85;
    const nombreSuc = nombres[s] || `sucursal ${s}`;

    const lineas = [];
    let alerta = false;
    for (const [tipo, ts] of Object.entries(porSuc[s])) {
      const h0 = mediana(ts.map(t => t.h_ap)), h1 = mediana(ts.map(t => t.h_ci));
      const apertura = mediana(ts.map(t => t.apertura).filter(x => x != null));
      if (h0 == null || h1 == null || apertura == null) continue;
      let ef = 0;
      for (let h = h0; h < h1; h++) ef += ph[h]?.efectivo || 0;
      const efEsperado = p.valor_predicho * (ef / totalDia);
      const meta = apertura + efEsperado;
      const minimo = apertura + efEsperado * factorMin;
      const conPatron = patrones.some(x => String(x.sucursal_id) === String(s) && x.tipo_turno === tipo && x.dow === dowM);
      if (conPatron) alerta = true;
      lineas.push({ tipo, h0, h1, apertura, efEsperado, meta, minimo, conPatron });
    }
    if (!lineas.length) continue;
    lineas.sort((a, b) => a.h0 - b.h0);

    recs.push({
      id: 'CAJA_META_CIERRE',
      categoria: 'caja',
      prioridad: alerta ? 'alta' : 'info',
      mensaje: `Mañana (${DIA[dowM]} ${fechaCorta(manana)}) en ${nombreSuc}, así deberían cerrar las cajas: ` +
        lineas.map(l => `turno ${nombreTurno(l.tipo)} (${l.h0}–${l.h1} h) cerca de ${fmt(l.meta)} ` +
          `(apertura ${fmt(l.apertura)} + ~${fmt(l.efEsperado)} en efectivo)`).join('; ') + '.' +
        (alerta ? ' Ojo: es el día y turno con faltantes recurrentes.' : ''),
      accion: lineas.map(l => `si el turno ${nombreTurno(l.tipo)} cierra por debajo de ${fmt(l.minimo)}, revisalo en el momento`).join('; ')
        .replace(/^./, c => c.toUpperCase()) + '.',
      datos: { sucursal_id: Number(s), fecha: manana, turnos: lineas.map(l => ({ tipo: l.tipo, meta: Math.round(l.meta), minimo: Math.round(l.minimo), efectivo_esperado: Math.round(l.efEsperado) })) },
    });
  }
  return recs;
}

// ─── Orquestador ──────────────────────────────────────────────────────────────
async function recomendacionesEcosistema(negocioId, sucursalId = null, db = pool, opciones = {}) {
  const tRes = await db.query(
    `SELECT id, sucursal_id, tipo_turno, estado, brecha::float AS brecha,
            caja_apertura::float AS apertura,
            to_char(${FL_AP}::date, 'YYYY-MM-DD') AS dia,
            EXTRACT(DOW FROM ${FL_AP})::int AS dow,
            EXTRACT(HOUR FROM ${FL_AP})::int AS h_ap,
            EXTRACT(HOUR FROM (hora_cierre - INTERVAL '3 hours'))::int AS h_ci,
            (conteo_aleatorio_hora IS NOT NULL) AS conteo_programado,
            COALESCE(conteo_aleatorio_omitido, false) AS omitido
     FROM turnos_caja
     WHERE negocio_id = $1 AND hora_apertura >= NOW() - INTERVAL '60 days'
       AND ($2::integer IS NULL OR sucursal_id = $2)`,
    [negocioId, sucursalId]
  );
  const turnos = tRes.rows;

  const nRes = await db.query(`SELECT id, nombre FROM mis_sucursales WHERE negocio_id = $1`, [negocioId]);
  const nombres = Object.fromEntries(nRes.rows.map(r => [String(r.id), limpiarNombre(r.nombre)]));

  const recs = [];
  const seguro = async (nombre, fn) => {
    try { return await fn(); } catch (e) { console.error(`Recomendaciones ${nombre} fallaron:`, e.message); return null; }
  };

  const control = await seguro('control', () => recomendacionesControl(negocioId, sucursalId, db, turnos, nombres));
  if (control) recs.push(...control.recs);
  const caja = await seguro('caja', () => recomendacionesCaja(negocioId, sucursalId, db, turnos, nombres, control?.patrones || [], opciones));
  if (caja) recs.push(...caja);
  const pred = await seguro('prediccion', () => recomendacionesDePrediccion(negocioId, sucursalId, db, opciones));
  if (pred) recs.push(...pred);

  recs.forEach(r => { r.mensaje = cap(r.mensaje); });
  return recs;
}

module.exports = { recomendacionesEcosistema };
