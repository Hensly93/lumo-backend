// "Tu negocio en vivo" — la sala de situación de LumoBi (14/11/2026).
// Una sola respuesta con lo que PASÓ, lo que ESTÁ PASANDO y lo que VIENE, armada con las mismas
// fuentes que el resto de la app (en_vivo, predicción, informe de turno, lista de revisar),
// para que ningún número de la sala contradiga a otra pantalla.
const pool = require('./db');
const { negocioEnVivo } = require('./en_vivo');
const { calcularPrediccion } = require('./prediccion_adaptativa');

const { FL } = require('./ventas_sql');
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const r0 = (n) => Math.round(Number(n) || 0);
const mediana = (a) => { if (!a.length) return null; const o = [...a].sort((x, y) => x - y); const m = Math.floor(o.length / 2); return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
const masDias = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dowDe = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

async function sala(negocioId, sucursalId = null, db = pool) {
  const vivo = await negocioEnVivo(negocioId, sucursalId);
  const hoy = vivo.ahora.fecha;
  const hora = vivo.ahora.hora;
  const ayer = masDias(hoy, -1);
  const manana = masDias(hoy, 1);

  // ── Ventas por hora de hoy y por día de las últimas 8 semanas (mismo filtro de local) ──
  const [porHora, porDia, turnos] = await Promise.all([
    db.query(`SELECT EXTRACT(HOUR FROM ${FL})::int h, SUM(monto)::float total, COUNT(*)::int tickets
                FROM transacciones WHERE negocio_id=$1 AND ${FL}::date=$2::date AND ($3::integer IS NULL OR sucursal_id=$3)
               GROUP BY 1 ORDER BY 1`, [negocioId, hoy, sucursalId]),
    db.query(`SELECT to_char(${FL}::date,'YYYY-MM-DD') d, SUM(monto)::float total, COUNT(*)::int tickets
                FROM transacciones WHERE negocio_id=$1 AND ${FL}::date >= $2::date AND ${FL}::date < $3::date
                 AND ($4::integer IS NULL OR sucursal_id=$4)
               GROUP BY 1`, [negocioId, masDias(hoy, -56), hoy, sucursalId]),
    db.query(`SELECT t.id, t.nombre_empleado, t.tipo_turno, t.sucursal_id, s.nombre sucursal,
                     to_char(t.hora_apertura - INTERVAL '3 hours','HH24:MI') desde,
                     COALESCE((SELECT SUM(monto) FROM transacciones x WHERE x.turno_id=t.id),0)::float ventas,
                     COALESCE((SELECT COUNT(*) FROM transacciones x WHERE x.turno_id=t.id),0)::int tickets
                FROM turnos_caja t LEFT JOIN mis_sucursales s ON s.id=t.sucursal_id
               WHERE t.negocio_id=$1 AND t.estado='activo' AND ($2::integer IS NULL OR t.sucursal_id=$2)
               ORDER BY t.hora_apertura`, [negocioId, sucursalId]),
  ]);

  // ── Predicción de hoy (hora por hora) y de mañana, con el mismo modelo de Predicciones ──
  let predHoy = null, predManana = null;
  try {
    const p = await calcularPrediccion(negocioId, sucursalId, db, null, { incluirHoy: true, guardar: false });
    if (p && p.disponible) {
      const de = (f) => (p.predicciones || []).find((x) => String(x.fecha_target).slice(0, 10) === f) || null;
      predHoy = de(hoy); predManana = de(manana);
    }
  } catch (e) { console.error('sala/prediccion:', e.message); }

  // ── LO QUE ESTÁ PASANDO ──
  // El total del día es el mismo del Inicio (suma local por local); la curva hora por hora se escala a ese total
  const t = vivo.total || {};
  const escala = predHoy && predHoy.valor_predicho > 0 && t.esperado_dia > 0 ? t.esperado_dia / predHoy.valor_predicho : 1;
  const esperadoHora = Object.fromEntries(((predHoy && predHoy.franjas && predHoy.franjas.por_hora) || []).map((x) => [x.hora, x.esperado * escala]));
  const realHora = Object.fromEntries(porHora.rows.map((r) => [r.h, r]));
  const horas = [...new Set([...Object.keys(esperadoHora), ...Object.keys(realHora)].map(Number))].sort((a, b) => a - b);
  const horaPorHora = horas.map((h) => ({
    hora: h,
    vendido: realHora[h] ? r0(realHora[h].total) : (h <= hora ? 0 : null),
    tickets: realHora[h] ? realHora[h].tickets : 0,
    esperado: esperadoHora[h] != null ? r0(esperadoHora[h]) : null,
    estado: h < hora ? 'paso' : h === hora ? 'ahora' : 'viene',
  }));
  const ahoraBloque = {
    hora: `${hora}:${String(vivo.ahora.minuto).padStart(2, '0')}`,
    vendido: r0(t.ventas), tickets: t.tickets || 0,
    esperado_hasta_ahora: t.esperado_hasta_ahora != null ? r0(t.esperado_hasta_ahora) : null,
    cajas_abiertas: turnos.rows.map((x) => ({
      quien: x.nombre_empleado, turno: x.tipo_turno === 'manana' ? 'mañana' : x.tipo_turno, local: x.sucursal,
      desde: x.desde, vendido: r0(x.ventas), tickets: x.tickets,
    })),
    hora_por_hora: horaPorHora,
  };

  // ── LO QUE PASÓ ──
  const dias = porDia.rows;
  const diaAyer = dias.find((d) => d.d === ayer);
  const normalAyer = mediana(dias.filter((d) => d.d !== ayer && dowDe(d.d) === dowDe(ayer)).map((d) => d.total));
  let informe = null;
  try { informe = await require('./primeros_dias').informeTurno(negocioId, { sucursalId }); } catch (e) { console.error('sala/informe:', e.message); }
  const paso = {
    ayer: {
      dia: DIAS[dowDe(ayer)], vendido: diaAyer ? r0(diaAyer.total) : 0, tickets: diaAyer ? diaAyer.tickets : 0,
      normal: normalAyer != null ? r0(normalAyer) : null,
      dif_pct: normalAyer > 0 && diaAyer ? Math.round((diaAyer.total / normalAyer - 1) * 100) : null,
    },
    ultimo_turno: informe ? { titulo: informe.titulo, diferencia_caja: informe.diferencia_caja, turno_id: informe.turno_id,
      hechos: (informe.hechos || []).slice(0, 3).map((h) => h.texto) } : null,
  };

  // ── LO QUE VIENE ──
  const resto = horaPorHora.filter((x) => x.estado === 'viene' && x.esperado != null);
  const pico = resto.reduce((a, x) => (!a || x.esperado > a.esperado ? x : a), null);
  const viene = {
    resto_del_dia: resto.length ? r0(resto.reduce((s, x) => s + x.esperado, 0)) : null,
    cierre_esperado: t.esperado_dia != null ? r0(t.esperado_dia) : (predHoy ? r0(predHoy.valor_predicho) : null),
    proxima_hora_fuerte: pico ? { hora: pico.hora, esperado: pico.esperado } : null,
    manana: predManana ? {
      dia: predManana.dia_semana, esperado: r0(predManana.valor_predicho),
      rango: predManana.rango_min ? [r0(predManana.rango_min), r0(predManana.rango_max)] : null,
      porque: (predManana.efectos || []).map((e) => ({ texto: e.descripcion, pesos: r0(e.efecto_pesos) })),
      hora_fuerte: predManana.franjas && predManana.franjas.hora_pico ? predManana.franjas.hora_pico.hora : null,
    } : null,
  };

  // ── Para mirar (la misma lista que el Inicio y Alertas) ──
  let revisar = [];
  try {
    const { analizarNegocio } = require('./motor');
    const analisis = await analizarNegocio(negocioId, sucursalId);
    revisar = (await require('./revisar').itemsRevisar(negocioId, sucursalId, analisis, null)).items
      .slice(0, 4).map((a) => ({ prioridad: a.prioridad, mensaje: a.mensaje, url: a.url || '/alertas' }));
  } catch (e) { console.error('sala/revisar:', e.message); }

  return { fecha: hoy, sucursal_id: sucursalId, paso, ahora: ahoraBloque, viene, revisar };
}

module.exports = { sala };
