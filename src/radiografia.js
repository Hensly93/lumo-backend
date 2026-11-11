// radiografia.js — "Radiografía de 60 segundos": los hallazgos más valiosos del negocio, con plata y evidencia.
// Usa lo que ya existe: ventas por día y por hora (transacciones) y las fugas ya calculadas (caja y rentabilidad).
// Cada hallazgo: { id, tipo: 'medido'|'calculado'|'estimado', titulo, detalle, evidencia[], monto, url }
//   medido    = suma real (ej: faltantes de caja)
//   calculado = sale de las cuentas del negocio (ej: rentabilidad)
//   estimado  = oportunidad: lo que se ganaría si un día/franja rindiera como el resto
const pool = require('./db');

const FL = `(fecha - INTERVAL '3 hours')`;
const AHORA_AR = `(NOW() - INTERVAL '3 hours')`;
const VENTANA_DIAS = 56;     // 8 semanas
const MIN_DIAS = 14;         // con menos días con ventas no se muestra radiografía de ventas
const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('es-AR');
const prom = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ── Detectores puros (reciben filas ya leídas; se pueden probar sin base) ──

// dias: [{ d:'2026-10-05', dow:1, total, tickets }]
function hallazgoDiaDebil(dias) {
  const porDow = new Map();
  for (const x of dias) {
    if (!porDow.has(x.dow)) porDow.set(x.dow, []);
    porDow.get(x.dow).push(x.total);
  }
  const validos = [...porDow.entries()].filter(([, v]) => v.length >= 3).map(([dow, v]) => ({ dow, n: v.length, avg: prom(v) }));
  if (validos.length < 4) return null;
  const peor = validos.reduce((a, b) => (b.avg < a.avg ? b : a));
  const resto = validos.filter((v) => v.dow !== peor.dow);
  const ref = prom(resto.map((v) => v.avg));
  if (!(ref > 0)) return null;
  const brecha = 1 - peor.avg / ref;
  if (brecha < 0.2) return null;
  const pct = Math.round(brecha * 100);
  const nombre = DOW[peor.dow];
  const monto = Math.round((ref - peor.avg) * 4.3);
  return {
    id: 'dia_debil_' + peor.dow,
    tipo: 'estimado',
    titulo: `Los ${nombre} vendés ${pct}% menos que el resto de la semana`,
    detalle: `Un ${nombre} promedia ${fmt(peor.avg)} y los demás días ${fmt(ref)}.`,
    evidencia: [
      `Se miraron ${peor.n} ${nombre} de las últimas 8 semanas.`,
      `Si ese día rindiera como los demás, serían unos ${fmt(monto)} más por mes (estimación).`,
    ],
    monto,
    url: '/predicciones',
  };
}

// horas: [{ d, h, total }] — por día y hora; nDias = días con ventas en la ventana
function hallazgoFranjaFloja(horas, nDias) {
  if (nDias < MIN_DIAS) return null;
  const porHora = new Map();
  for (const x of horas) porHora.set(x.h, (porHora.get(x.h) || 0) + x.total);
  const avg = new Map([...porHora.entries()].map(([h, t]) => [h, t / nDias]));
  // horas en las que el negocio realmente opera: con ventas en al menos 30% de los días
  const diasConHora = new Map();
  for (const x of horas) diasConHora.set(x.h, (diasConHora.get(x.h) || 0) + 1);
  const abiertas = [...diasConHora.entries()].filter(([, n]) => n >= 0.3 * nDias).map(([h]) => h).sort((a, b) => a - b);
  if (abiertas.length < 6) return null;
  const desde = abiertas[0], hasta = abiertas[abiertas.length - 1];
  const franjas = [];
  for (let h = desde + 1; h + 1 < hasta; h++) {       // se excluye la primera y la última hora (arranque y cierre)
    if (!abiertas.includes(h) || !abiertas.includes(h + 1)) continue;
    franjas.push({ h, v: (avg.get(h) || 0) + (avg.get(h + 1) || 0) });
  }
  if (franjas.length < 3) return null;
  const media = prom(franjas.map((f) => f.v));
  const peor = franjas.reduce((a, b) => (b.v < a.v ? b : a));
  if (!(media > 0)) return null;
  const brecha = 1 - peor.v / media;
  if (brecha < 0.3) return null;
  const diasMes = (nDias / (VENTANA_DIAS / 7)) * 4.3;     // días abiertos por mes
  const monto = Math.round((media - peor.v) * diasMes);
  return {
    id: 'franja_floja_' + peor.h,
    tipo: 'estimado',
    titulo: `De ${peor.h} a ${peor.h + 2} h es tu franja más floja`,
    detalle: `Vendés ${Math.round(brecha * 100)}% menos que en una franja promedio de dos horas (${fmt(peor.v)} contra ${fmt(media)}).`,
    evidencia: [
      `Promedio de las últimas 8 semanas, ${nDias} días con ventas.`,
      `Con una promo o un combo que la acerque al promedio, serían unos ${fmt(monto)} más por mes (estimación).`,
    ],
    monto,
    url: '/predicciones',
  };
}

// dias: igual que arriba. Compara los últimos 28 días contra los 28 anteriores.
function hallazgoTicket(dias, hoyISO) {
  const hoy = new Date(hoyISO + 'T00:00:00Z').getTime();
  const edad = (d) => Math.floor((hoy - new Date(d + 'T00:00:00Z').getTime()) / 86400000);
  const act = dias.filter((x) => edad(x.d) >= 1 && edad(x.d) <= 28);
  const ant = dias.filter((x) => edad(x.d) > 28 && edad(x.d) <= 56);
  const tA = act.reduce((s, x) => s + x.tickets, 0), tP = ant.reduce((s, x) => s + x.tickets, 0);
  if (tA < 20 || tP < 20) return null;
  const vA = act.reduce((s, x) => s + x.total, 0) / tA, vP = ant.reduce((s, x) => s + x.total, 0) / tP;
  const cambio = vA / vP - 1;
  if (Math.abs(cambio) < 0.08) return null;
  const pct = Math.round(Math.abs(cambio) * 100);
  const monto = Math.round(Math.abs(vP - vA) * tA);
  const baja = cambio < 0;
  return {
    id: baja ? 'ticket_baja' : 'ticket_sube',
    tipo: 'calculado',
    titulo: baja ? `Tu ticket promedio bajó ${pct}%` : `Tu ticket promedio subió ${pct}%`,
    detalle: `Pasó de ${fmt(vP)} a ${fmt(vA)} por venta, en los últimos 28 días contra los 28 anteriores.`,
    evidencia: [
      `${tA} ventas en los últimos 28 días y ${tP} en los 28 anteriores.`,
      'Son pesos de cada momento, sin ajustar por inflación.',
      baja ? `Esa diferencia, sobre tus ventas del período, son unos ${fmt(monto)}.` : `Esa diferencia, sobre tus ventas del período, son unos ${fmt(monto)} más.`,
    ],
    monto: baja ? monto : 0,     // una mejora se muestra, pero no compite por el podio de "plata en juego"
    url: '/periodos',
    positivo: !baja,
  };
}

function deFugas(fugas) {
  return (fugas || [])
    .filter((f) => f.estado === 'activa' && !f.incluida_en && f.monto > 0)
    .sort((a, b) => b.monto - a.monto)
    .slice(0, 2)
    .map((f) => ({
      id: 'fuga_' + f.id,
      tipo: f.monto_tipo === 'medido' ? 'medido' : 'calculado',
      titulo: f.titulo,
      detalle: f.donde ? `Dónde: ${f.donde}.` : '',
      evidencia: (f.evidencia || []).slice(0, 3),
      monto: f.monto,
      url: f.url || '/fugas',
    }));
}

function elegir(hallazgos, max = 3) {
  const conMonto = hallazgos.filter((h) => !h.positivo).sort((a, b) => b.monto - a.monto);
  const buenos = hallazgos.filter((h) => h.positivo);
  const top = conMonto.slice(0, max);
  // Una pérdida medida de verdad (ej: faltantes de caja) siempre entra: es lo más creíble que hay
  const medido = conMonto.find((h) => h.tipo === 'medido');
  if (medido && !top.includes(medido)) top[top.length - 1] = medido;
  return [...top, ...buenos].slice(0, max);
}

async function calcularRadiografia(negocioId, db = pool, opts = {}) {
  const fuentes = Object.assign({ fugas: (id) => require('./fugas').calcularFugas(id) }, opts.fuentes || {});
  const ventana = `${FL} >= ${AHORA_AR}::date - INTERVAL '${VENTANA_DIAS} days' AND ${FL}::date < ${AHORA_AR}::date`;
  const [dRes, hRes, fRes, hoyRes] = await Promise.allSettled([
    db.query(`SELECT ${FL}::date::text AS d, EXTRACT(DOW FROM ${FL})::int AS dow, SUM(monto)::float AS total, COUNT(*)::int AS tickets
                FROM transacciones WHERE negocio_id = $1 AND ${ventana} GROUP BY 1, 2 HAVING SUM(monto) > 0`, [negocioId]),
    db.query(`SELECT ${FL}::date::text AS d, EXTRACT(HOUR FROM ${FL})::int AS h, SUM(monto)::float AS total
                FROM transacciones WHERE negocio_id = $1 AND ${ventana} GROUP BY 1, 2 HAVING SUM(monto) > 0`, [negocioId]),
    fuentes.fugas(negocioId),
    db.query(`SELECT ${AHORA_AR}::date::text AS hoy`),
  ]);
  for (const [n, r] of [['dias', dRes], ['horas', hRes], ['fugas', fRes]]) {
    if (r.status === 'rejected') console.error('radiografia/' + n + ':', r.reason && r.reason.message);
  }
  const dias = dRes.status === 'fulfilled' ? dRes.value.rows : [];
  const horas = hRes.status === 'fulfilled' ? hRes.value.rows : [];
  const hoy = hoyRes.status === 'fulfilled' ? hoyRes.value.rows[0].hoy : new Date().toISOString().slice(0, 10);
  const nDias = new Set(dias.map((x) => x.d)).size;
  const suficiente = nDias >= MIN_DIAS;

  const hallazgos = [];
  if (suficiente) {
    for (const f of [() => hallazgoDiaDebil(dias), () => hallazgoFranjaFloja(horas, nDias), () => hallazgoTicket(dias, hoy)]) {
      try { const h = f(); if (h) hallazgos.push(h); } catch (e) { console.error('radiografia/detector:', e.message); }
    }
  }
  if (fRes.status === 'fulfilled') hallazgos.push(...deFugas(fRes.value.fugas));

  const top = elegir(hallazgos, 3);
  return {
    suficiente,
    dias_con_ventas: nDias,
    dias_necesarios: MIN_DIAS,
    faltan_dias: Math.max(0, MIN_DIAS - nDias),
    hallazgos: top,
  };
}

module.exports = { calcularRadiografia, hallazgoDiaDebil, hallazgoFranjaFloja, hallazgoTicket, deFugas, elegir, MIN_DIAS };
