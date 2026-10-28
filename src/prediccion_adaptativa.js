// prediccion_adaptativa.js — LumoBi (reescrito 27/10/2026)
// Motor de predicción adaptativa por negocio_id
//
// Cambios respecto de la versión S9:
//   - Todo por negocio_id (antes usuario_id: dejaba afuera las ventas del empleado
//     y el INSERT fallaba por negocio_id NOT NULL → nunca se guardó nada).
//   - Señal propia = VENTA DIARIA real (SUM por día, después promedio por día de semana).
//     Antes era AVG(monto) = ticket promedio.
//   - dias_datos = días CON ventas en los últimos 60 días (antes: días desde la primera venta).
//   - Confianza por escalones de NICOLE: <7d 50% · 7-14 65% · 15-29 80% · 30+ 95%.
//   - Sin ventas recientes → disponible:false, motivo 'sin_ventas_recientes' (antes predecía $0).
//   - Nuevo: franjas_hoy (hora pico y hora floja del día de hoy).
//   - Guarda una sola vez por día y sucursal (antes insertaba en cada visita).
//
// Pesos:
//   W1 = señal propia  (crece con días con ventas, máx 0.70)
//   W2 = señal zona    (inactivo hasta 5+ negocios por zona)
//   W3 = señal país    (contexto_pais — feriados, quincenas, aguinaldo)
//
// Ventana adaptativa (por antigüedad del negocio):
//   < 60 días  → predice 7 días  (semana)
//   60-180     → predice 30 días (mes)
//   180+       → predice 90 días (trimestre)

const pool = require('./db');

// ─── Zona horaria ─────────────────────────────────────────────────────────────
// transacciones.fecha es timestamp SIN zona. Se asume que se guarda en UTC
// (servidor en Render). Para agrupar por día y hora de Argentina se restan 3 h.
// VERIFICAR con una venta de hora conocida antes del lanzamiento.
const OFFSET_MS = 3 * 60 * 60 * 1000;
const FECHA_LOCAL = `(fecha - INTERVAL '3 hours')`;

const VENTANA_DIAS = 60;
const MINIMO_DIAS_CON_VENTAS = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// "Ahora" corrido a hora argentina. Usar SIEMPRE métodos getUTC*/setUTC* sobre esto.
function hoyArgentina() {
  return new Date(Date.now() - OFFSET_MS);
}

function fechasEnRango(desde, dias) {
  const result = [];
  for (let i = 1; i <= dias; i++) {
    const d = new Date(desde.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    result.push(d);
  }
  return result;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function confianzaPorDias(dias) {
  if (dias >= 30) return 0.95;
  if (dias >= 15) return 0.80;
  if (dias >= 7)  return 0.65;
  return 0.50;
}

async function ownerDeNegocio(negocio_id, db = pool) {
  const r = await db.query(
    `SELECT usuario_id FROM negocio_usuarios
     WHERE negocio_id = $1 AND rol = 'owner' AND activo = true
     ORDER BY usuario_id LIMIT 1`,
    [negocio_id]
  );
  return r.rows[0]?.usuario_id ?? null;
}

// ─── Calcular predicción ──────────────────────────────────────────────────────

async function calcularPrediccion(negocio_id, sucursal_id = null, db = pool, riesgo_contexto = null) {
  if (!negocio_id) {
    return { disponible: false, motivo: 'sin_negocio', minimo_requerido: MINIMO_DIAS_CON_VENTAS };
  }

  // 1. Antigüedad del negocio (todo el historial)
  const histRes = await db.query(
    `SELECT MIN(fecha) AS primera, COUNT(*) AS total
     FROM transacciones
     WHERE negocio_id = $1
       AND ($2::integer IS NULL OR sucursal_id = $2)`,
    [negocio_id, sucursal_id]
  );
  const primera = histRes.rows[0].primera;
  const totalHistorico = Number(histRes.rows[0].total);
  const antiguedad_dias = primera
    ? Math.floor((Date.now() - new Date(primera).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // 2. Venta diaria real en la ventana reciente
  const diariasRes = await db.query(
    `SELECT to_char(${FECHA_LOCAL}::date, 'YYYY-MM-DD') AS dia,
            EXTRACT(DOW FROM ${FECHA_LOCAL})::integer      AS dia_semana,
            SUM(monto)                                     AS total,
            COUNT(*)                                       AS tickets
     FROM transacciones
     WHERE negocio_id = $1
       AND fecha >= NOW() - INTERVAL '${VENTANA_DIAS} days'
       AND ($2::integer IS NULL OR sucursal_id = $2)
     GROUP BY 1, 2`,
    [negocio_id, sucursal_id]
  );
  const diarias = diariasRes.rows.map(r => ({
    dia: r.dia,
    dia_semana: r.dia_semana,
    total: parseFloat(r.total),
    tickets: parseInt(r.tickets),
  }));
  const dias_datos = diarias.length;

  if (dias_datos < MINIMO_DIAS_CON_VENTAS) {
    return {
      disponible: false,
      motivo: totalHistorico > 0 ? 'sin_ventas_recientes' : 'datos_insuficientes',
      minimo_requerido: MINIMO_DIAS_CON_VENTAS,
      dias_con_ventas: dias_datos,
      ventana_dias: VENTANA_DIAS,
    };
  }

  // 3. Señal propia — promedio de venta diaria por día de semana
  const acumPorDia = {};
  let sumaTotal = 0;
  diarias.forEach(d => {
    if (!acumPorDia[d.dia_semana]) acumPorDia[d.dia_semana] = { suma: 0, n: 0 };
    acumPorDia[d.dia_semana].suma += d.total;
    acumPorDia[d.dia_semana].n += 1;
    sumaTotal += d.total;
  });
  const señalPorDia = {};
  Object.keys(acumPorDia).forEach(k => {
    señalPorDia[k] = acumPorDia[k].suma / acumPorDia[k].n;
  });
  const promedioGeneral = sumaTotal / dias_datos;

  // 4. Pesos
  const W1 = Math.min(dias_datos / VENTANA_DIAS, 0.70);
  const W2 = 0; // activar cuando haya 5+ negocios por zona
  const W3 = 1 - W1 - W2;

  // 5. Ventana adaptativa
  let horizonte, dias_prediccion;
  if (antiguedad_dias < 60)       { horizonte = 'semana';    dias_prediccion = 7;  }
  else if (antiguedad_dias < 180) { horizonte = 'mes';       dias_prediccion = 30; }
  else                            { horizonte = 'trimestre'; dias_prediccion = 90; }

  // 6. Señal país — eventos en la ventana de predicción
  const hoy = hoyArgentina();
  const fechaFin = new Date(hoy.getTime());
  fechaFin.setUTCDate(fechaFin.getUTCDate() + dias_prediccion);

  const paisRes = await db.query(
    `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, tipo, intensidad, descripcion
     FROM contexto_pais
     WHERE fecha >= $1 AND fecha <= $2
     ORDER BY fecha ASC`,
    [toISODate(hoy), toISODate(fechaFin)]
  );
  const eventosPorFecha = {};
  paisRes.rows.forEach(r => {
    if (!eventosPorFecha[r.fecha]) eventosPorFecha[r.fecha] = [];
    eventosPorFecha[r.fecha].push({ tipo: r.tipo, intensidad: parseFloat(r.intensidad), descripcion: r.descripcion });
  });

  // 7. Confianza
  const confianza = confianzaPorDias(dias_datos);

  // 8. Predicción por fecha
  const predicciones = [];
  for (const fecha of fechasEnRango(hoy, dias_prediccion)) {
    const dow = fecha.getUTCDay(); // 0=Dom ... 6=Sab
    const fechaStr = toISODate(fecha);

    const señal_propia = señalPorDia[dow] ?? promedioGeneral;
    const eventos = eventosPorFecha[fechaStr] ?? [];
    const intensidad_pais = eventos.length > 0
      ? eventos.reduce((acc, e) => acc * e.intensidad, 1.0)
      : 1.0;
    const señal_pais = señal_propia * intensidad_pais;

    // W2 inactivo → valor_predicho = W1 * propia + W3 * pais
    const valor_predicho = W1 * señal_propia + W3 * señal_pais;

    predicciones.push({
      fecha_target: fechaStr,
      valor_predicho: Math.round(valor_predicho * 100) / 100,
      confianza,
      horizonte,
      senales_usadas: {
        W1: Math.round(W1 * 1000) / 1000,
        W2,
        W3: Math.round(W3 * 1000) / 1000,
        dias_datos,
        señal_propia: Math.round(señal_propia * 100) / 100,
        dia_semana_con_datos: señalPorDia[dow] !== undefined,
        intensidad_pais,
        eventos_contexto: eventos,
      },
    });
  }

  // 9. Franjas de hoy — hora pico y hora floja (promedio por hora, mismo día de semana)
  const dowHoy = hoy.getUTCDay();
  const diasMismoDow = acumPorDia[dowHoy]?.n ?? 0;
  let franjas_hoy = null;
  if (diasMismoDow > 0) {
    const horasRes = await db.query(
      `SELECT EXTRACT(HOUR FROM ${FECHA_LOCAL})::integer AS hora,
              SUM(monto) AS total
       FROM transacciones
       WHERE negocio_id = $1
         AND fecha >= NOW() - INTERVAL '${VENTANA_DIAS} days'
         AND ($2::integer IS NULL OR sucursal_id = $2)
         AND EXTRACT(DOW FROM ${FECHA_LOCAL})::integer = $3
       GROUP BY 1
       ORDER BY 1`,
      [negocio_id, sucursal_id, dowHoy]
    );
    const por_hora = horasRes.rows.map(r => ({
      hora: r.hora,
      promedio: Math.round((parseFloat(r.total) / diasMismoDow) * 100) / 100,
    }));
    if (por_hora.length > 0) {
      const pico  = por_hora.reduce((a, b) => (b.promedio > a.promedio ? b : a));
      const floja = por_hora.reduce((a, b) => (b.promedio < a.promedio ? b : a));
      franjas_hoy = {
        fecha: toISODate(hoy),
        dia_semana: dowHoy,
        dias_base: diasMismoDow,
        por_hora,
        hora_pico: pico,
        hora_floja: floja,
      };
    }
  }

  // 10. Guardar en predicciones_negocio — una sola vez por día y sucursal
  const fecha_prediccion = toISODate(hoy);
  const existeRes = await db.query(
    `SELECT 1 FROM predicciones_negocio
     WHERE negocio_id = $1
       AND sucursal_id IS NOT DISTINCT FROM $2::integer
       AND fecha_prediccion = $3
     LIMIT 1`,
    [negocio_id, sucursal_id, fecha_prediccion]
  );
  if (existeRes.rows.length === 0) {
    for (const p of predicciones) {
      await db.query(
        `INSERT INTO predicciones_negocio
           (negocio_id, sucursal_id, fecha_prediccion, fecha_target, valor_predicho, confianza, senales_usadas, horizonte)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          negocio_id,
          sucursal_id,
          fecha_prediccion,
          p.fecha_target,
          p.valor_predicho,
          p.confianza,
          JSON.stringify(p.senales_usadas),
          p.horizonte,
        ]
      );
    }
  }

  return {
    disponible: true,
    horizonte,
    dias_datos,
    antiguedad_dias,
    confianza,
    pesos: { W1: Math.round(W1 * 1000) / 1000, W2, W3: Math.round(W3 * 1000) / 1000 },
    predicciones,
    total_fechas: predicciones.length,
    eventos_en_ventana: Object.keys(eventosPorFecha).length,
    franjas_hoy,
    fecha_prediccion,
    riesgo_contexto: riesgo_contexto ? {
      risk_score_final:     riesgo_contexto.risk_score_final,
      confirmacion_cruzada: riesgo_contexto.confirmacion_cruzada,
      debe_emitir:          riesgo_contexto.debe_emitir,
    } : null,
  };
}

module.exports = { calcularPrediccion, ownerDeNegocio };
