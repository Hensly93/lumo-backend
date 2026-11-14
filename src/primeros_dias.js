// primeros_dias.js — LumoBi · valor desde el primer turno (14/11/2026)
//
// El motor estadístico (alertas, CUSUM, ERM, predicción de 7 días) necesita historia. Una prueba de 5 días
// no la junta, y el dueño veía el Home vacío. Este módulo da valor con lo que YA hay:
//
//   informeTurno()          apenas cierra un turno: ventas, ticket, hora pico, efectivo, productos, caja
//                           y una acción concreta. Compara con el turno anterior del mismo tipo si existe.
//   proyeccionHoy()         desde el 2do día: a este ritmo, cuánto cerrás hoy (curva horaria propia)
//   prediccionPreliminar()  con 1 o 2 días completos: cuánto se espera hoy/mañana (hasta que la
//                           predicción completa de prediccion_adaptativa esté disponible al 3er día)
//   aprendizaje()           qué ya sabe LumoBi del negocio y cuánto falta para cada función
//
// Todo en hora Argentina (fecha se guarda en UTC sin zona). Montos siempre en pesos.

const pool = require('./db');
const { getBenchmarkSector, normalizarTipoNegocio } = require('./benchmarks_sector');

const FL = `(t.fecha - INTERVAL '3 hours')`;
const HOY_AR = `(NOW() - INTERVAL '3 hours')::date`;
const ES_EFECTIVO = `LOWER(COALESCE(t.metodo_pago,'')) IN ('efectivo','cash')`;
const REAL = `COALESCE(t.origin,'real') IN ('real','importado')`;
const TURNO_TXT = { manana: 'mañana', tarde: 'tarde', noche: 'noche' };
const RUBRO_TXT = {
  KIOSKO: 'kioscos', ALMACEN: 'almacenes', CAFETERIA: 'cafés y bares', RESTAURANTE: 'restaurantes',
  PARRILLA: 'parrillas', PANADERIA: 'panaderías', FARMACIA: 'farmacias', RETAIL: 'comercios',
};

const $ = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');
const pct = (x) => Math.round((Number(x) || 0) * 100);
const rango = (h) => `${h} a ${(h + 1) % 24} h`;

// ─── Datos base ───────────────────────────────────────────────────────────────

async function conteos(negocioId, sucursalId = null, db = pool) {
  const r = await db.query(
    `SELECT
       (SELECT COUNT(DISTINCT ${FL}::date) FROM transacciones t
         WHERE t.negocio_id=$1 AND ${REAL} AND ($2::integer IS NULL OR t.sucursal_id=$2) AND ${FL}::date < ${HOY_AR}) AS dias_completos,
       (SELECT COUNT(*) FROM transacciones t
         WHERE t.negocio_id=$1 AND ${REAL} AND ($2::integer IS NULL OR t.sucursal_id=$2) AND ${FL}::date = ${HOY_AR}) AS ventas_hoy,
       (SELECT COUNT(*) FROM transacciones t WHERE t.negocio_id=$1 AND ${REAL} AND ($2::integer IS NULL OR t.sucursal_id=$2)) AS ventas_total,
       (SELECT COUNT(*) FROM turnos_caja WHERE negocio_id=$1 AND estado='cerrado' AND ($2::integer IS NULL OR sucursal_id=$2)) AS turnos_cerrados,
       (SELECT COALESCE(MAX(c),0) FROM (SELECT COUNT(*) c FROM turnos_caja WHERE negocio_id=$1 AND estado='cerrado'
          AND ($2::integer IS NULL OR sucursal_id=$2) GROUP BY LOWER(tipo_turno)) x) AS max_turnos_mismo_tipo,
       (SELECT COALESCE(MAX(c),0) FROM (SELECT COUNT(*) c FROM turnos_caja WHERE negocio_id=$1 AND estado='cerrado'
          AND ($2::integer IS NULL OR sucursal_id=$2) AND hora_apertura >= NOW() - INTERVAL '30 days' GROUP BY nombre_empleado) y) AS max_turnos_empleado,
       (SELECT COUNT(*) FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id
         WHERE t.negocio_id=$1 AND ($2::integer IS NULL OR t.sucursal_id=$2)) AS items_con_producto`,
    [negocioId, sucursalId]
  );
  const x = r.rows[0];
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, parseInt(v, 10) || 0]));
}

// ─── Aprendizaje: qué ya sabe LumoBi ──────────────────────────────────────────

async function aprendizaje(negocioId, sucursalId = null, db = pool) {
  const c = await conteos(negocioId, sucursalId, db);
  const etapa = (id, nombre, actual, meta, [sing, plur], que_da) => {
    const f = meta - actual;
    return {
      id, nombre, que_da, listo: actual >= meta,
      progreso: Math.min(1, actual / meta), actual: Math.min(actual, meta), meta,
      falta: f <= 0 ? null : `Falta${f === 1 ? '' : 'n'} ${f} ${f === 1 ? sing : plur}`,
    };
  };
  const etapas = [
    etapa('informe_turno', 'Informe de cada turno', c.turnos_cerrados, 1, ['turno cerrado', 'turnos cerrados'], 'Al cerrar cada caja: cuánto se vendió, la hora pico, la diferencia de caja y qué hacer.'),
    etapa('proyeccion_hoy', 'Proyección del día', c.dias_completos, 1, ['día de ventas', 'días de ventas'], 'Durante el día: a este ritmo, cuánto vas a cerrar hoy.'),
    etapa('prediccion', 'Predicción de los próximos 7 días', c.dias_completos, 3, ['día de ventas', 'días de ventas'], 'Cuánto vas a vender cada día, con clima y calendario.'),
    etapa('desvios', 'Avisos de desvíos por turno', c.max_turnos_mismo_tipo, 5, ['turno', 'turnos'], 'Te avisa cuando un turno vende o cierra la caja fuera de lo normal.'),
    etapa('equipo', 'Riesgo del equipo', c.max_turnos_empleado, 3, ['turno del mismo empleado', 'turnos del mismo empleado'], 'Patrones de cada empleado: diferencias de caja, ticket y conteos.'),
  ];
  const listas = etapas.filter((e) => e.listo).length;
  return {
    ...c,
    etapas,
    listas,
    total: etapas.length,
    completo: listas === etapas.length,
    siguiente: etapas.find((e) => !e.listo) || null,
  };
}

// ─── Informe del turno ────────────────────────────────────────────────────────

async function informeTurno(negocioId, opts = {}, db = pool) {
  const { turnoId = null, sucursalId = null } = opts;
  const tr = await db.query(
    `SELECT id, negocio_id, nombre_empleado, LOWER(tipo_turno) AS tipo_turno, hora_apertura, hora_cierre,
            caja_apertura, caja_esperada, caja_cierre, brecha, sucursal_id
     FROM turnos_caja
     WHERE negocio_id=$1 AND estado='cerrado'
       AND ($2::integer IS NULL OR id=$2)
       AND ($3::integer IS NULL OR sucursal_id=$3)
       AND ($2::integer IS NOT NULL OR hora_cierre >= NOW() - INTERVAL '36 hours')
     ORDER BY hora_cierre DESC LIMIT 1`,
    [negocioId, turnoId, sucursalId]
  );
  const t = tr.rows[0];
  if (!t) return null;

  const filtro = `t.negocio_id = $1 AND ${REAL} AND (t.turno_id = $2 OR (t.turno_id IS NULL AND t.empleado = $3
                  AND t.fecha >= $4 AND t.fecha <= $5 AND t.sucursal_id IS NOT DISTINCT FROM $6::integer))`;
  const params = [negocioId, t.id, t.nombre_empleado, t.hora_apertura, t.hora_cierre, t.sucursal_id];

  const [tot, horas, prods] = await Promise.all([
    db.query(`SELECT COUNT(*)::int n, COALESCE(SUM(monto),0)::float total,
                     COALESCE(SUM(CASE WHEN ${ES_EFECTIVO} THEN monto ELSE 0 END),0)::float efectivo
              FROM transacciones t WHERE ${filtro}`, params),
    db.query(`SELECT EXTRACT(HOUR FROM ${FL})::int h, SUM(monto)::float total, COUNT(*)::int n
              FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 1`, params),
    db.query(`SELECT COALESCE(d.producto_nombre, 'Producto') nombre, SUM(d.cantidad)::float unidades, SUM(d.subtotal)::float total,
                     SUM(CASE WHEN d.costo_unitario > 0 THEN d.subtotal - d.costo_unitario * d.cantidad END)::float ganancia
              FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
              WHERE ${filtro} GROUP BY 1 ORDER BY 3 DESC LIMIT 5`, params).catch(() => ({ rows: [] })),
  ]);
  const { n, total, efectivo } = tot.rows[0];
  if (!n) return null;

  const ticket = total / n;
  const ratioEf = total > 0 ? efectivo / total : 0;
  const pico = horas.rows.reduce((a, b) => (b.total > (a ? a.total : -1) ? b : a), null);
  const horasOrd = [...horas.rows].sort((a, b) => b.total - a.total);
  const top2 = horasOrd.slice(0, 2);
  const shareTop2 = total > 0 ? top2.reduce((a, b) => a + b.total, 0) / total : 0;
  const brecha = t.brecha != null ? parseFloat(t.brecha) : null;
  const turnoTxt = TURNO_TXT[t.tipo_turno] || t.tipo_turno;

  // Turno anterior del mismo tipo (mismo local) para comparar
  const prev = await db.query(
    `SELECT tc.id, (SELECT COALESCE(SUM(monto),0)::float FROM transacciones t WHERE t.negocio_id=$1
        AND (t.turno_id = tc.id OR (t.turno_id IS NULL AND t.empleado = tc.nombre_empleado AND t.fecha >= tc.hora_apertura
             AND t.fecha <= tc.hora_cierre AND t.sucursal_id IS NOT DISTINCT FROM tc.sucursal_id))) total
     FROM turnos_caja tc
     WHERE tc.negocio_id=$1 AND tc.estado='cerrado' AND LOWER(tc.tipo_turno)=$2 AND tc.id <> $3
       AND tc.sucursal_id IS NOT DISTINCT FROM $4::integer AND tc.hora_cierre < $5
     ORDER BY tc.hora_cierre DESC LIMIT 1`,
    [negocioId, t.tipo_turno, t.id, t.sucursal_id, t.hora_apertura]
  );
  const anterior = prev.rows[0] && prev.rows[0].total > 0 ? prev.rows[0].total : null;

  // Referencia del rubro (rango orientativo)
  let rubro = null;
  try {
    const neg = await db.query('SELECT tipo_negocio FROM negocios WHERE id=$1', [negocioId]);
    const canon = normalizarTipoNegocio(neg.rows[0] && neg.rows[0].tipo_negocio);
    const b = await getBenchmarkSector(canon);
    if (b.ticket_promedio) rubro = { nombre: RUBRO_TXT[canon] || 'tu rubro', ticket_min: +b.ticket_promedio.valor_min, ticket_max: +b.ticket_promedio.valor_max };
  } catch (e) { /* sin referencia */ }

  // ── Hechos (de más a menos plata en juego) ──
  const hechos = [];
  if (brecha != null && Math.abs(brecha) >= 200) {
    hechos.push({
      id: 'caja', peso: Math.abs(brecha) * 10,
      texto: `La caja cerró con ${$(brecha)} de diferencia (${brecha > 0 ? 'falta' : 'sobra'} efectivo).`,
      accion: 'Revisá ese cierre hoy, mientras está fresco: conteo, egresos sin cargar o un vuelto mal dado.',
      impacto_pesos: Math.round(Math.abs(brecha)),
    });
  } else if (brecha != null) {
    hechos.push({ id: 'caja_ok', peso: 1, texto: 'La caja cerró justa: lo contado coincide con lo vendido.', accion: '', impacto_pesos: 0 });
  }
  if (pico && horas.rows.length >= 3 && shareTop2 >= 0.35) {
    const hs = top2.map((x) => x.h).sort((a, b) => a - b);
    const franja = hs.length === 2 && hs[1] === hs[0] + 1 ? `las ${hs[0]} y las ${hs[1] + 1} h` : hs.map((h) => `las ${h} y las ${h + 1} h`).join(', y entre ');
    hechos.push({
      id: 'pico', peso: total * shareTop2 * 0.1,
      texto: `El ${pct(shareTop2)}% de lo vendido entró entre ${franja}.`,
      accion: 'En esa franja es donde más se pierde si falta cambio, mercadería o alguien en la caja: preparala antes.',
      impacto_pesos: Math.round(total * shareTop2),
    });
  }
  if (ratioEf >= 0.6) {
    hechos.push({
      id: 'efectivo', peso: efectivo * 0.05,
      texto: `El ${pct(ratioEf)}% (${$(efectivo)}) entró en efectivo.`,
      accion: 'Con tanto efectivo, el conteo al cerrar cada turno es lo que más protege tu plata.',
      impacto_pesos: Math.round(efectivo),
    });
  }
  const p0 = prods.rows[0];
  if (p0 && total > 0 && p0.total / total >= 0.2) {
    hechos.push({
      id: 'producto', peso: p0.total * 0.08,
      texto: `${p0.nombre} fue el ${pct(p0.total / total)}% de lo vendido (${$(p0.total)}).`,
      accion: `Que nunca te falte ${p0.nombre}: un día sin stock es perder esa plata.`,
      impacto_pesos: Math.round(p0.total),
    });
  }
  if (rubro && ticket < rubro.ticket_min * 0.8) {
    hechos.push({
      id: 'ticket', peso: n * (rubro.ticket_min - ticket) * 0.05,
      texto: `Tu ticket promedio (${$(ticket)}) está por debajo del rango de referencia de ${rubro.nombre}.`,
      accion: 'Sumar un producto chico al lado de la caja sube el ticket sin conseguir clientes nuevos.',
      impacto_pesos: Math.round(n * (rubro.ticket_min - ticket) * 0.2),
    });
  }
  if (anterior) {
    const dif = total / anterior - 1;
    if (Math.abs(dif) >= 0.15) {
      hechos.push({
        id: 'vs_anterior', peso: Math.abs(total - anterior) * 0.2,
        texto: `Vendiste ${pct(Math.abs(dif))}% ${dif > 0 ? 'más' : 'menos'} que el turno ${turnoTxt} anterior (${$(anterior)}).`,
        accion: dif > 0 ? '' : 'Si no hubo un motivo claro (clima, feriado), revisá qué cambió en ese turno.',
        impacto_pesos: Math.round(Math.abs(total - anterior)),
      });
    }
  }
  hechos.sort((a, b) => b.peso - a.peso);
  const principal = hechos.find((h) => h.accion) || hechos[0] || null;

  return {
    turno_id: t.id,
    tipo_turno: t.tipo_turno,
    empleado: t.nombre_empleado,
    sucursal_id: t.sucursal_id,
    cierre: t.hora_cierre,
    ventas: n,
    total: Math.round(total),
    ticket_promedio: Math.round(ticket),
    efectivo_pct: pct(ratioEf),
    hora_pico: pico ? { hora: pico.h, total: Math.round(pico.total), ventas: pico.n } : null,
    productos: prods.rows.map((p) => ({ nombre: p.nombre, unidades: Math.round(p.unidades), total: Math.round(p.total), ganancia: p.ganancia != null ? Math.round(p.ganancia) : null })),
    diferencia_caja: brecha,
    turno_anterior_total: anterior != null ? Math.round(anterior) : null,
    rubro,
    hechos: hechos.map(({ peso, ...h }) => h),
    titulo: `Turno ${turnoTxt}${t.nombre_empleado ? ' de ' + t.nombre_empleado : ''}: ${$(total)} en ${n} ventas`,
    resumen: [hechos[0], hechos[1]].filter(Boolean).map((h) => h.texto).join(' '),
    accion: principal ? principal.accion : '',
  };
}

// ─── Proyección de hoy (curva horaria propia) ─────────────────────────────────

async function proyeccionHoy(negocioId, sucursalId = null, db = pool) {
  const ahoraAR = new Date(Date.now() - 3 * 3600 * 1000);
  const horaAhora = ahoraAR.getUTCHours() + ahoraAR.getUTCMinutes() / 60;
  const r = await db.query(
    `SELECT ${FL}::date = ${HOY_AR} AS es_hoy, to_char(${FL}::date,'YYYY-MM-DD') dia,
            EXTRACT(HOUR FROM ${FL}) + EXTRACT(MINUTE FROM ${FL}) / 60.0 AS hora, monto::float monto
     FROM transacciones t
     WHERE t.negocio_id=$1 AND ${REAL} AND ($2::integer IS NULL OR t.sucursal_id=$2)
       AND ${FL}::date >= ${HOY_AR} - 14`,
    [negocioId, sucursalId]
  );
  const hoy = r.rows.filter((x) => x.es_hoy);
  const previos = r.rows.filter((x) => !x.es_hoy);
  const dias = [...new Set(previos.map((x) => x.dia))];
  if (!dias.length || hoy.length < 5) return null;

  // Qué parte del día suele estar vendida a esta hora
  const shares = dias.map((d) => {
    const filas = previos.filter((x) => x.dia === d);
    const tot = filas.reduce((a, b) => a + b.monto, 0);
    const hasta = filas.filter((x) => Number(x.hora) <= horaAhora).reduce((a, b) => a + b.monto, 0);
    return tot > 0 ? { share: hasta / tot, total: tot } : null;
  }).filter(Boolean);
  if (!shares.length) return null;
  const share = shares.reduce((a, b) => a + b.share, 0) / shares.length;
  const totalTipico = shares.reduce((a, b) => a + b.total, 0) / shares.length;
  const hastaAhora = hoy.reduce((a, b) => a + b.monto, 0);
  if (share < 0.15) return null; // muy temprano: proyectar sería adivinar

  const proyectado = hastaAhora / share;
  const vsTipico = totalTipico > 0 ? proyectado / totalTipico - 1 : 0;
  return {
    hasta_ahora: Math.round(hastaAhora),
    ventas_hoy: hoy.length,
    proyectado: Math.round(proyectado),
    dia_tipico: Math.round(totalTipico),
    vs_tipico_pct: Math.round(vsTipico * 100),
    parte_del_dia_pct: Math.round(share * 100),
    dias_base: dias.length,
    texto: `A este ritmo cerrás hoy en unos ${$(proyectado)}${Math.abs(vsTipico) >= 0.1 ? ` (${Math.round(Math.abs(vsTipico) * 100)}% ${vsTipico > 0 ? 'arriba' : 'abajo'} de un día normal tuyo)` : ', parecido a un día normal tuyo'}.`,
  };
}

// ─── Predicción preliminar (1 o 2 días completos) ─────────────────────────────

async function prediccionPreliminar(negocioId, sucursalId = null, db = pool) {
  const r = await db.query(
    `SELECT to_char(${FL}::date,'YYYY-MM-DD') dia, SUM(monto)::float total, COUNT(*)::int n
     FROM transacciones t
     WHERE t.negocio_id=$1 AND ${REAL} AND ($2::integer IS NULL OR t.sucursal_id=$2)
       AND ${FL}::date < ${HOY_AR} AND ${FL}::date >= ${HOY_AR} - 14
     GROUP BY 1 ORDER BY 1`,
    [negocioId, sucursalId]
  );
  const dias = r.rows.filter((d) => d.total > 0);
  if (!dias.length) return null;
  const prom = dias.reduce((a, b) => a + b.total, 0) / dias.length;
  const margen = dias.length === 1 ? 0.4 : 0.3;
  return {
    disponible: true,
    preliminar: true,
    dias_base: dias.length,
    esperado_dia: Math.round(prom),
    rango: [Math.round(prom * (1 - margen)), Math.round(prom * (1 + margen))],
    confianza_pct: dias.length === 1 ? 35 : 45,
    texto: `Estimación preliminar con ${dias.length} día${dias.length === 1 ? '' : 's'} de ventas: un día normal tuyo ronda ${$(prom)}. Desde el 3er día LumoBi suma día de la semana, clima y calendario.`,
  };
}

module.exports = { aprendizaje, informeTurno, proyeccionHoy, prediccionPreliminar, conteos };
