// vigilante_valor.js — LumoBi · avisos con valor durante todo el día (14/11/2026)
//
// Se suman a los detectores del Vigilante (corre cada hora). Funcionan desde el primer turno, no solo
// con semanas de historia, y cada uno trae una acción concreta:
//
//   informe_turno      al cerrar cada caja: cuánto, hora pico, diferencia de caja y qué hacer
//   pico_proximo       ~1 h antes de la franja fuerte del día: cuánto entra ahí y qué preparar
//   producto_caliente  un producto se vende mucho más que lo normal a esta hora → combo con lo que
//                      sus clientes ya compran juntos, antes de que termine la franja
//   proyeccion_dia     a media tarde: a este ritmo cerrás en $X (si viene muy distinto a lo normal)
//   prediccion_manana  a la noche: cuánto se espera mañana y qué preparar
//   hallazgo_wow       una vez por día: el hallazgo con más plata que el dueño no sabía
//
// Reglas del Vigilante: entre 8 y 22:30, nunca el mismo aviso dos veces, sin nombres de empleados en el
// aviso (se ven en la pantalla bloqueada del celu). Los avisos del momento (solo_push) no van por mail.

const FL = "(t.fecha - INTERVAL '3 hours')";
const REAL = "COALESCE(t.origin,'real') IN ('real','importado')";
const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const TURNOS_ES = { manana: 'mañana', tarde: 'tarde', noche: 'noche' };
const pesos = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');
const recorte = (s, n = 300) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const sinTabla = (e) => e && (e.code === '42P01' || e.code === '42703');
const franjaTxt = (h) => `${h} a ${h + 2} h`;

// Franja fuerte: las 2 horas seguidas que más venden (últimos 14 días, sin hoy)
async function franjaFuerte(db, negocioId) {
  const r = await db.query(
    `SELECT EXTRACT(HOUR FROM ${FL})::int h, SUM(t.monto)::float total, COUNT(DISTINCT ${FL}::date)::int dias
     FROM transacciones t
     WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= (NOW() - INTERVAL '3 hours')::date - 14
       AND ${FL}::date < (NOW() - INTERVAL '3 hours')::date
     GROUP BY 1 ORDER BY 1`, [negocioId]);
  const por = new Map(r.rows.map((x) => [x.h, x]));
  const dias = Math.max(0, ...r.rows.map((x) => x.dias));
  if (dias < 2) return null;
  const totalDia = r.rows.reduce((a, b) => a + b.total, 0) / dias;
  let mejor = null;
  for (const x of r.rows) {
    const y = por.get(x.h + 1);
    const suma = x.total + (y ? y.total : 0);
    if (!mejor || suma > mejor.suma) mejor = { h: x.h, suma };
  }
  if (!mejor || !(totalDia > 0)) return null;
  const porDia = mejor.suma / dias;
  return { h: mejor.h, por_dia: porDia, share: porDia / totalDia, dias };
}

// ── 1) Informe de cada turno ───────────────────────────────────────────────────
async function detInformeTurno(db, p) {
  const r = await db.query(
    `SELECT id FROM turnos_caja WHERE negocio_id=$1 AND estado='cerrado'
       AND hora_cierre >= NOW() - INTERVAL '100 minutes' ORDER BY hora_cierre DESC LIMIT 2`, [p.negocioId]);
  const out = [];
  for (const { id } of r.rows) {
    const inf = await require('./primeros_dias').informeTurno(p.negocioId, { turnoId: id }, db);
    if (!inf || !inf.hechos.length) continue;
    const turno = TURNOS_ES[inf.tipo_turno] || inf.tipo_turno;
    const caja = inf.hechos.find((h) => h.id === 'caja');
    const otros = inf.hechos.filter((h) => h.id !== 'caja' && h.id !== 'caja_ok').slice(0, 2).map((h) => h.texto);
    const partes = [`${pesos(inf.total)} en ${inf.ventas} ventas, ticket promedio ${pesos(inf.ticket_promedio)}.`];
    if (caja) partes.push(caja.texto);
    partes.push(...otros);
    if (inf.accion) partes.push('Qué hacer: ' + inf.accion);
    out.push({
      tipo: 'informe_turno', contexto: 't' + id, pref: caja ? 'alertas_criticas' : 'resumen_diario', prioridad: caja ? 2 : 5,
      titulo: caja ? `Cerró el turno ${turno} con ${pesos(caja.impacto_pesos)} de diferencia` : `Cerró el turno ${turno}: ${pesos(inf.total)}`,
      mensaje: recorte(partes.join(' '), 450), url: '/', boton: 'Ver el turno',
    });
  }
  return out;
}

// ── 2) La franja fuerte está por arrancar ──────────────────────────────────────
async function detPicoProximo(db, p) {
  const { reloj, negocioId } = p;
  if (reloj.hora < 8 || reloj.hora > 21) return [];
  const f = await franjaFuerte(db, negocioId);
  if (!f || f.share < 0.2) return [];
  const faltan = f.h - reloj.hora;
  if (faltan < 0.25 || faltan > 1.25) return [];                     // corre cada hora: avisa una vez, ~1 h antes
  const prods = await db.query(
    `SELECT COALESCE(d.producto_nombre, 'Producto') nombre, SUM(d.cantidad)::float u
     FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id
     WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= (NOW() - INTERVAL '3 hours')::date - 14
       AND EXTRACT(HOUR FROM ${FL}) IN ($2, $3)
     GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [negocioId, f.h, f.h + 1]).catch(() => ({ rows: [] }));
  const lista = prods.rows.map((x) => x.nombre);
  return [{
    tipo: 'pico_proximo', contexto: reloj.hoy, pref: 'resumen_diario', prioridad: 4, solo_push: true,
    titulo: `En ${Math.round(faltan * 60) >= 50 ? '1 hora' : Math.round(faltan * 60) + ' minutos'} arranca tu franja fuerte (${franjaTxt(f.h)})`,
    mensaje: recorte(`Ahí entra el ${Math.round(f.share * 100)}% de lo del día, unos ${pesos(f.por_dia)}.`
      + (lista.length ? ` Lo que más sale en esa franja: ${lista.join(', ')} — fijate que no falte.` : '')
      + ' Caja con cambio y nadie de descanso.'),
    url: '/', boton: 'Ver mi negocio',
  }];
}

// ── 3) Un producto se vende mucho más que lo normal (con combo listo) ──────────
async function detProductoCaliente(db, p) {
  const { reloj, negocioId } = p;
  if (reloj.hora < 11 || reloj.hora > 21) return [];
  const h = Math.floor(reloj.hora);
  const desde = Math.max(0, h - 3);
  let r;
  try {
    r = await db.query(
      `WITH x AS (
         SELECT COALESCE(d.producto_nombre, pr.nombre) nombre, ${FL}::date dia, SUM(d.cantidad)::float u
         FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id LEFT JOIN productos pr ON pr.id=d.producto_id
         WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= (NOW() - INTERVAL '3 hours')::date - 14
           AND EXTRACT(HOUR FROM ${FL}) >= $2 AND EXTRACT(HOUR FROM ${FL}) < $3
         GROUP BY 1, 2),
       dias AS (SELECT COUNT(DISTINCT ${FL}::date)::int n FROM transacciones t WHERE t.negocio_id=$1
                AND ${FL}::date >= (NOW() - INTERVAL '3 hours')::date - 14 AND ${FL}::date < (NOW() - INTERVAL '3 hours')::date)
       SELECT nombre,
              COALESCE(SUM(u) FILTER (WHERE dia = (NOW() - INTERVAL '3 hours')::date), 0) hoy,
              COALESCE(SUM(u) FILTER (WHERE dia < (NOW() - INTERVAL '3 hours')::date), 0) / NULLIF((SELECT n FROM dias), 0) normal,
              (SELECT n FROM dias) dias
       FROM x GROUP BY nombre`, [negocioId, desde, h + 1]);
  } catch (e) { if (sinTabla(e)) return []; throw e; }
  const cand = r.rows
    .filter((x) => x.dias >= 3 && x.hoy >= 5 && x.hoy >= (x.normal || 0) * 1.8 && x.hoy - (x.normal || 0) >= 3)
    .sort((a, b) => (b.hoy - b.normal) - (a.hoy - a.normal))[0];
  if (!cand) return [];
  const veces = cand.normal > 0 ? cand.hoy / cand.normal : null;

  // Con qué lo compran sus clientes (para el combo)
  const par = await db.query(
    `WITH tx AS (SELECT DISTINCT d.transaccion_id FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id
                 WHERE t.negocio_id=$1 AND ${REAL} AND d.producto_nombre=$2 AND ${FL}::date >= (NOW() - INTERVAL '3 hours')::date - 30)
     SELECT d.producto_nombre nombre, COUNT(DISTINCT d.transaccion_id)::float n, (SELECT COUNT(*) FROM tx)::float base
     FROM transacciones_detalle d JOIN tx ON tx.transaccion_id = d.transaccion_id
     WHERE d.producto_nombre <> $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [negocioId, cand.nombre]).catch(() => ({ rows: [] }));
  const comp = par.rows[0] && par.rows[0].base >= 5 && par.rows[0].n / par.rows[0].base >= 0.2 ? par.rows[0] : null;

  const st = await db.query(
    'SELECT stock FROM productos WHERE negocio_id=$1 AND nombre=$2 AND stock IS NOT NULL LIMIT 1', [negocioId, cand.nombre]).catch(() => ({ rows: [] }));
  const stock = st.rows[0] ? Number(st.rows[0].stock) : null;

  const f = await franjaFuerte(db, negocioId).catch(() => null);
  const hasta = f && f.h + 2 > reloj.hora ? `hasta las ${f.h + 2} h` : 'en lo que queda del día';
  const cuanto = !veces ? 'mucho más que lo normal' : veces >= 2 ? `${Math.round(veces)} veces lo normal` : `${Math.round((veces - 1) * 100)}% más que lo normal`;
  const partes = [`Hoy ${cand.nombre} se está vendiendo ${cuanto} a esta hora: ${Math.round(cand.hoy)} desde las ${desde} h.`];
  if (comp) partes.push(`Aprovechalo: ofrecé ${cand.nombre} + ${comp.nombre} ${hasta} (el ${Math.round((comp.n / comp.base) * 100)}% de los que llevan ${cand.nombre} ya lo suman).`);
  else partes.push(`Aprovechalo ${hasta}: tenelo a la vista al lado de la caja.`);
  if (stock != null && stock <= cand.hoy) partes.push(`Ojo: según LumoBi te quedan ${Math.max(0, Math.round(stock))}.`);
  return [{
    tipo: 'producto_caliente', contexto: `${reloj.hoy}|${recorte(cand.nombre, 60)}`, pref: 'alertas_medias', prioridad: 3, solo_push: true,
    titulo: recorte(`${cand.nombre} se está vendiendo más que nunca hoy`, 110),
    mensaje: recorte(partes.join(' ')), url: '/productos', boton: 'Ver productos',
  }];
}

// ── 4) A este ritmo, cuánto cerrás hoy ─────────────────────────────────────────
async function detProyeccionDia(db, p) {
  const { reloj, negocioId, dias } = p;
  if (reloj.hora < 13 || reloj.hora > 20) return [];
  if (dias.filter((d) => d.dia < reloj.hoy).length >= 8) return []; // con historia lo cubre ritmo_bajo / ritmo_alto
  const pr = await require('./primeros_dias').proyeccionHoy(negocioId, null, db);
  if (!pr || Math.abs(pr.vs_tipico_pct) < 20) return [];
  const baja = pr.vs_tipico_pct < 0;
  return [{
    tipo: baja ? 'proyeccion_baja' : 'proyeccion_alta', contexto: reloj.hoy, pref: 'alertas_medias', prioridad: baja ? 2 : 5, solo_push: true,
    titulo: baja ? 'Hoy viene más flojo que tus otros días' : 'Hoy viene mejor que tus otros días',
    mensaje: recorte(`Llevás ${pesos(pr.hasta_ahora)}. ${pr.texto} `
      + (baja ? 'Si no hay un motivo claro (clima, horario), probá una promo en lo que queda del día o revisá que se estén registrando todas las ventas.'
              : 'Revisá que no te falte mercadería para lo que queda del día.')),
    url: '/', boton: 'Ver mi negocio',
  }];
}

// ── 5) Cuánto se espera mañana ─────────────────────────────────────────────────
async function detPrediccionManana(db, p) {
  const { reloj, negocioId, dias } = p;
  if (reloj.hora < 19.5 || reloj.hora > 21.75) return [];
  const manana = new Date(Date.parse(reloj.hoy + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const dowM = (reloj.dow + 1) % 7;
  let esperado = null, rango = null, motivos = [], prelim = false;
  try {
    const pred = await require('./prediccion_adaptativa').calcularPrediccion(negocioId, null, db, null, { guardar: false });
    if (pred && pred.disponible) {
      const x = (pred.predicciones || []).find((y) => y.fecha_target === manana || String(y.fecha_target).slice(0, 10) === manana);
      if (x) {
        esperado = Number(x.valor_predicho);
        if (x.rango_min && x.rango_max) rango = [Number(x.rango_min), Number(x.rango_max)];
        motivos = (x.efectos || []).filter((f) => f.variable !== 'tendencia').map((f) => `${f.descripcion} (${f.efecto_pesos > 0 ? '+' : '-'}${pesos(f.efecto_pesos)})`).slice(0, 2);
      }
    }
  } catch (e) { console.error('[VIGILANTE] prediccion_manana', e.message); }
  if (esperado == null) {
    const pre = await require('./primeros_dias').prediccionPreliminar(negocioId, null, db);
    if (pre) { esperado = pre.esperado_dia; rango = pre.rango; prelim = true; }
  }
  if (!(esperado > 0)) return [];
  const normales = dias.filter((d) => d.dia < reloj.hoy).map((d) => d.total);
  const normal = normales.length ? normales.reduce((a, b) => a + b, 0) / normales.length : null;
  const dif = normal ? esperado / normal - 1 : 0;
  // El día flojo con promo lo cubre el consejero (con 3 semanas de historia)
  if (dias.length >= 21 && dif <= -0.35) return [];

  const top = await db.query(
    `SELECT COALESCE(d.producto_nombre,'Producto') nombre, SUM(d.cantidad)::float u
     FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id
     WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= (NOW() - INTERVAL '3 hours')::date - 28
       AND ($2::int IS NULL OR EXTRACT(DOW FROM ${FL}) = $2)
     GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [negocioId, normales.length >= 14 ? dowM : null]).catch(() => ({ rows: [] }));
  const lista = top.rows.map((x) => x.nombre);

  const partes = [`Mañana ${DIAS_ES[dowM]} se esperan unos ${pesos(esperado)}${rango ? ` (entre ${pesos(rango[0])} y ${pesos(rango[1])})` : ''}`
    + (normal && Math.abs(dif) >= 0.1 ? `, ${Math.round(Math.abs(dif) * 100)}% ${dif > 0 ? 'más' : 'menos'} que un día normal tuyo.` : '.')];
  if (motivos.length) partes.push(`Por qué: ${motivos.join(', ').toLowerCase()}.`);
  if (dif >= 0.1 && lista.length) partes.push(`Reforzá stock de ${lista.join(', ')} y que haya alguien más en la caja en la franja fuerte.`);
  else if (dif <= -0.1) partes.push('Es un buen día para reponer, ordenar o probar una promo en tu hora más floja.');
  else if (lista.length) partes.push(`Que no falte: ${lista.join(', ')}.`);
  if (prelim) partes.push('Es una estimación preliminar: se afina sola con cada día.');
  return [{
    tipo: 'prediccion_manana', contexto: reloj.hoy, pref: 'resumen_diario', prioridad: 5,
    titulo: `Mañana ${DIAS_ES[dowM]}: unos ${pesos(esperado)}`,
    mensaje: recorte(partes.join(' ')), url: '/predicciones', boton: 'Ver predicciones',
  }];
}

// ── 6) El hallazgo del día (lo que el dueño no sabía) ─────────────────────────
async function detHallazgoWow(db, p) {
  const { reloj, negocioId } = p;
  if (reloj.hora < 10 || reloj.hora > 13) return [];
  const lista = await require('./hallazgos_wow').hallazgosWow(negocioId, db).catch(() => []);
  for (const h of lista) {
    if (!(h.impacto_pesos > 0)) continue;
    if (h.id === 'ticket_empleado') continue; // trae nombres: se ve en la pantalla, no en el aviso del celu
    const ya = await db.query(
      `SELECT 1 FROM vigilante_envios WHERE negocio_id=$1 AND tipo='hallazgo_wow' AND left(contexto, char_length($2)) = $2
         AND creado >= NOW() - INTERVAL '7 days' LIMIT 1`, [negocioId, h.id + '|']);
    if (ya.rows.length) continue;
    return [{
      tipo: 'hallazgo_wow', contexto: `${h.id}|${reloj.hoy}`, pref: 'alertas_medias', prioridad: 4,
      titulo: recorte(h.titulo, 110),
      mensaje: recorte(`${h.descripcion} ${h.recomendacion}`),
      url: '/', boton: 'Ver el hallazgo',
    }];
  }
  return [];
}

module.exports = {
  DETECTORES: [detInformeTurno, detPicoProximo, detProductoCaliente, detProyeccionDia, detPrediccionManana, detHallazgoWow],
  franjaFuerte,
};
