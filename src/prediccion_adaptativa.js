// prediccion_adaptativa.js — LumoBi · modelo de condiciones (28/10/2026)
//
// Idea: cada día pasado se "limpia" de las condiciones que tuvo (clima, calendario,
// tendencia) y cada día futuro recibe las condiciones que va a tener.
//
//   log(venta_dia) = intercepto + sucursal + dia_semana
//                  + β_lluvia + β_calor + β_frio            (clima de ESE día y sucursal)
//                  + β_quincena + β_feriado + β_aguinaldo    (contexto_pais)
//                  + β_tendencia · t
//
// Los β se APRENDEN por negocio (regresión ridge). Cada β arranca en un valor previo
// (prior) y se corrige con los datos propios: con pocos días de una condición pesa
// más el prior; con muchos, pesan los datos.
//   - Calendario: prior = intensidad promedio de contexto_pais (quincena 1.15, etc.).
//   - Clima: prior NEUTRO (factor 1.00). Lo que NICOLE muestre lo aprendió de los datos.
//
// Reglas de NICOLE respetadas:
//   - Solo variables de VOLUMEN. Detección (CUSUM, z-score, ERM, brechas) NO entra.
//   - Transparencia: cada día devuelve el efecto en pesos de cada variable.
//
// Pendiente (no incluido a propósito): inflación. Con ventana de 60 días la tendencia
// absorbe buena parte; se conecta cuando se valide calcularIndiceInflacion.
//
// Si hay menos de MIN_DIAS_MODELO días con ventas, usa el modelo simple (promedio por
// día de semana) y lo informa en `modelo.tipo`.

const https = require('https');
const pool = require('./db');

// ─── Constantes ───────────────────────────────────────────────────────────────
// transacciones.fecha es timestamp sin zona, guardado en UTC (DB en UTC, verificado 27/10).
const FL = `(fecha - INTERVAL '3 hours')`; // fecha local Argentina
const OFFSET_MS = 3 * 60 * 60 * 1000;

const VENTANA_DIAS = 60;
const HORIZONTE_DIAS = 7;            // decisión de Hens: 7 días fijos
const MINIMO_DIAS_CON_VENTAS = 3;
const MIN_DIAS_MODELO = 14;          // por debajo → modelo simple
const Z_RANGO = 1.28;                // rango 80%

const FACTORES_CLIMA = ['lluvia', 'calor_extremo', 'frio_extremo'];
const FACTORES_CALENDARIO = ['quincena', 'feriado', 'aguinaldo'];

const LAMBDA = {
  intercepto: 0,
  sucursal: 0.001,
  dia_semana: 0.01,  // casi libre: con λ alto el efecto del día se "aplana" hacia el domingo
  clima: 3,          // el prior vale como 3 días observados
  calendario: 3,
  tendencia: 5,
};

const NOMBRE_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DESCRIPCION = {
  lluvia: 'Lluvia',
  calor_extremo: 'Calor extremo',
  frio_extremo: 'Frío extremo',
  quincena: 'Quincena',
  feriado: 'Feriado',
  aguinaldo: 'Aguinaldo',
  tendencia: 'Tendencia de las últimas semanas',
};

// ─── Helpers de fechas (siempre strings YYYY-MM-DD en hora argentina) ─────────
function hoyAR() {
  return new Date(Date.now() - OFFSET_MS).toISOString().slice(0, 10);
}
function sumarDias(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function difDias(a, b) { // a - b en días
  return Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
}
function dowDe(iso) {
  return new Date(iso + 'T00:00:00Z').getUTCDay();
}
function r2(n) { return Math.round(n * 100) / 100; }
function r0(n) { return Math.round(n); }

function confianzaPorDias(dias) {
  if (dias >= 30) return 0.95;
  if (dias >= 15) return 0.80;
  if (dias >= 7)  return 0.65;
  return 0.50;
}

function etiquetaClima(precip, tempMax) {
  if (precip >= 5) return 'lluvia';
  if (tempMax >= 35) return 'calor_extremo';
  if (tempMax <= 5) return 'frio_extremo';
  return 'normal';
}

// ─── Álgebra: resolver A·x = b (eliminación gaussiana con pivoteo) ────────────
function resolver(A, b) {
  const n = b.length;
  const M = A.map((fila, i) => [...fila, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let f = c + 1; f < n; f++) if (Math.abs(M[f][c]) > Math.abs(M[piv][c])) piv = f;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let f = 0; f < n; f++) {
      if (f === c) continue;
      const k = M[f][c] / M[c][c];
      if (k === 0) continue;
      for (let j = c; j <= n; j++) M[f][j] -= k * M[c][j];
    }
  }
  return M.map((fila, i) => fila[n] / fila[i]);
}

// ─── Pronóstico de clima (Open-Meteo) ─────────────────────────────────────────
function pronosticoClima(lat, lon, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=precipitation_sum,temperature_2m_max&timezone=America%2FArgentina%2FBuenos_Aires` +
      `&forecast_days=${HORIZONTE_DIAS + 2}`;
    const t = setTimeout(() => resolve(null), timeoutMs);
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        clearTimeout(t);
        try {
          const j = JSON.parse(data);
          const out = {};
          (j.daily?.time || []).forEach((f, i) => {
            const p = j.daily.precipitation_sum?.[i] ?? 0;
            const tm = j.daily.temperature_2m_max?.[i] ?? 20;
            out[f] = { clima: etiquetaClima(p, tm), precipitacion_mm: p, temp_max: tm };
          });
          resolve(out);
        } catch { resolve(null); }
      });
    }).on('error', () => { clearTimeout(t); resolve(null); });
  });
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
// opciones.guardar = false → no escribe en predicciones_negocio (para pruebas)
// opciones.pronostico = { [sucursal_id]: { 'YYYY-MM-DD': {clima,...} } } → inyectar (pruebas)
async function calcularPrediccion(negocio_id, sucursal_id = null, db = pool, riesgo_contexto = null, opciones = {}) {
  const guardar = opciones.guardar !== false;
  if (!negocio_id) {
    return { disponible: false, motivo: 'sin_negocio', minimo_requerido: MINIMO_DIAS_CON_VENTAS };
  }

  const hoy = hoyAR();
  const desde = sumarDias(hoy, -VENTANA_DIAS);

  // 1. Venta diaria por sucursal (sin el día de hoy, que está incompleto)
  const dRes = await db.query(
    `SELECT sucursal_id,
            to_char(${FL}::date, 'YYYY-MM-DD') AS dia,
            SUM(monto)  AS total,
            COUNT(*)    AS tickets
     FROM transacciones
     WHERE negocio_id = $1
       AND ${FL}::date >= $2::date
       AND ${FL}::date <  $3::date
       AND ($4::integer IS NULL OR sucursal_id = $4)
     GROUP BY 1, 2`,
    [negocio_id, desde, hoy, sucursal_id]
  );
  const obs = dRes.rows
    .map(r => ({ suc: r.sucursal_id, dia: r.dia, total: parseFloat(r.total), tickets: parseInt(r.tickets) }))
    .filter(o => o.total > 0);
  const diasDistintos = new Set(obs.map(o => o.dia)).size;

  if (diasDistintos < MINIMO_DIAS_CON_VENTAS) {
    const h = await db.query(
      `SELECT COUNT(*) AS total FROM transacciones
       WHERE negocio_id = $1 AND ($2::integer IS NULL OR sucursal_id = $2)`,
      [negocio_id, sucursal_id]
    );
    return {
      disponible: false,
      motivo: Number(h.rows[0].total) > 0 ? 'sin_ventas_recientes' : 'datos_insuficientes',
      minimo_requerido: MINIMO_DIAS_CON_VENTAS,
      dias_con_ventas: diasDistintos,
      ventana_dias: VENTANA_DIAS,
    };
  }

  const sucKeys = [...new Set(obs.map(o => String(o.suc)))].sort();
  const sucIds = sucKeys.filter(k => k !== 'null').map(Number);
  const fin = sumarDias(hoy, HORIZONTE_DIAS);

  // 2. Contexto: clima histórico, calendario, priors
  const climaHist = {};
  if (sucIds.length) {
    const cRes = await db.query(
      `SELECT sucursal_id, to_char(fecha, 'YYYY-MM-DD') AS dia, clima
       FROM clima_historico
       WHERE sucursal_id = ANY($1::int[]) AND fecha >= $2::date`,
      [sucIds, desde]
    );
    cRes.rows.forEach(r => { climaHist[`${r.sucursal_id}|${r.dia}`] = r.clima; });
  }

  const calRes = await db.query(
    `SELECT to_char(fecha, 'YYYY-MM-DD') AS dia, tipo, intensidad, descripcion
     FROM contexto_pais
     WHERE fecha >= $1::date AND fecha <= $2::date`,
    [desde, fin]
  );
  const calendario = {};
  calRes.rows.forEach(r => {
    if (!calendario[r.dia]) calendario[r.dia] = [];
    calendario[r.dia].push({ tipo: r.tipo, intensidad: parseFloat(r.intensidad), descripcion: r.descripcion });
  });

  const priRes = await db.query(`SELECT tipo, AVG(intensidad) AS i FROM contexto_pais GROUP BY tipo`);
  const priorCal = {};
  priRes.rows.forEach(r => { priorCal[r.tipo] = parseFloat(r.i); });

  // 3. Ticket promedio por sucursal y perfil horario por día de semana
  const ticketProm = {};
  sucKeys.forEach(k => {
    const os = obs.filter(o => String(o.suc) === k);
    const t = os.reduce((a, o) => a + o.tickets, 0);
    ticketProm[k] = t > 0 ? os.reduce((a, o) => a + o.total, 0) / t : null;
  });

  const hRes = await db.query(
    `SELECT EXTRACT(DOW FROM ${FL})::integer AS dow,
            EXTRACT(HOUR FROM ${FL})::integer AS hora,
            SUM(monto) AS total
     FROM transacciones
     WHERE negocio_id = $1
       AND ${FL}::date >= $2::date
       AND ${FL}::date <  $3::date
       AND ($4::integer IS NULL OR sucursal_id = $4)
     GROUP BY 1, 2`,
    [negocio_id, desde, hoy, sucursal_id]
  );
  const perfilHora = {}; // dow → { hora: total }
  const totalDow = {};
  hRes.rows.forEach(r => {
    if (!perfilHora[r.dow]) perfilHora[r.dow] = {};
    perfilHora[r.dow][r.hora] = parseFloat(r.total);
    totalDow[r.dow] = (totalDow[r.dow] || 0) + parseFloat(r.total);
  });
  const diasPorDow = {};
  [...new Set(obs.map(o => o.dia))].forEach(d => { const w = dowDe(d); diasPorDow[w] = (diasPorDow[w] || 0) + 1; });

  function franjasPara(dow, totalDia) {
    const p = perfilHora[dow];
    if (!p || !totalDow[dow]) return null;
    const por_hora = Object.keys(p).map(Number).sort((a, b) => a - b).map(h => ({
      hora: h,
      esperado: r0(totalDia * p[h] / totalDow[dow]),
    }));
    if (!por_hora.length) return null;
    const pico = por_hora.reduce((a, b) => (b.esperado > a.esperado ? b : a));
    const floja = por_hora.reduce((a, b) => (b.esperado < a.esperado ? b : a));
    return { por_hora, hora_pico: pico, hora_floja: floja };
  }

  // 4. Pronóstico de clima por sucursal
  const pronostico = {};
  const climaPronosticoOk = {};
  if (opciones.pronostico) {
    Object.assign(pronostico, opciones.pronostico);
    sucIds.forEach(id => { climaPronosticoOk[id] = !!pronostico[id]; });
  } else if (sucIds.length) {
    const coords = await db.query(
      `SELECT id, latitud, longitud FROM mis_sucursales
       WHERE id = ANY($1::int[]) AND latitud IS NOT NULL AND longitud IS NOT NULL`,
      [sucIds]
    );
    await Promise.all(coords.rows.map(async c => {
      pronostico[c.id] = await pronosticoClima(c.latitud, c.longitud);
      climaPronosticoOk[c.id] = !!pronostico[c.id];
    }));
  }

  const confianza = confianzaPorDias(diasDistintos);
  let modelo;
  let predicciones;

  if (diasDistintos >= MIN_DIAS_MODELO) {
    // ─── 5a. Modelo de condiciones ───────────────────────────────────────────
    const params = [];
    const add = (nombre, prior, lambda, grupo) => { params.push({ nombre, prior, lambda, grupo }); return params.length - 1; };
    const iInt = add('intercepto', 0, LAMBDA.intercepto, 'base');
    const iSuc = {};
    sucKeys.slice(1).forEach(k => { iSuc[k] = add(`sucursal_${k}`, 0, LAMBDA.sucursal, 'base'); });
    const iDow = {};
    for (let d = 1; d <= 6; d++) iDow[d] = add(`dia_${d}`, 0, LAMBDA.dia_semana, 'dia_semana');
    const iFac = {};
    FACTORES_CLIMA.forEach(f => { iFac[f] = add(f, 0, LAMBDA.clima, 'clima'); });
    FACTORES_CALENDARIO.forEach(f => {
      iFac[f] = add(f, Math.log(priorCal[f] ?? 1), LAMBDA.calendario, 'calendario');
    });
    const iTen = add('tendencia', 0, LAMBDA.tendencia, 'tendencia');
    const P = params.length;

    function fila(suc, dia, climaDia) {
      const x = new Array(P).fill(0);
      x[iInt] = 1;
      if (iSuc[String(suc)] !== undefined) x[iSuc[String(suc)]] = 1;
      const w = dowDe(dia);
      if (w !== 0) x[iDow[w]] = 1;
      if (FACTORES_CLIMA.includes(climaDia)) x[iFac[climaDia]] = 1;
      (calendario[dia] || []).forEach(e => { if (iFac[e.tipo] !== undefined) x[iFac[e.tipo]] = 1; });
      x[iTen] = difDias(dia, hoy) / 30;
      return x;
    }

    const X = obs.map(o => fila(o.suc, o.dia, climaHist[`${o.suc}|${o.dia}`] || 'normal'));
    const y = obs.map(o => Math.log(o.total));

    const A = Array.from({ length: P }, () => new Array(P).fill(0));
    const b = new Array(P).fill(0);
    X.forEach((x, n) => {
      for (let i = 0; i < P; i++) {
        if (x[i] === 0) continue;
        b[i] += x[i] * y[n];
        for (let j = 0; j < P; j++) if (x[j] !== 0) A[i][j] += x[i] * x[j];
      }
    });
    params.forEach((p, i) => { A[i][i] += p.lambda; b[i] += p.lambda * p.prior; });
    const beta = resolver(A, b);

    if (beta) {
      const resid = X.map((x, n) => y[n] - x.reduce((a, v, i) => a + v * beta[i], 0));
      const gl = Math.max(1, obs.length - P);
      const sigma = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / gl);
      const smear = resid.reduce((a, r) => a + Math.exp(r), 0) / resid.length;

      const nCond = {};
      Object.keys(iFac).forEach(f => { nCond[f] = X.filter(x => x[iFac[f]] === 1).length; });

      modelo = {
        tipo: 'condiciones',
        observaciones: obs.length,
        dias_con_ventas: diasDistintos,
        sucursales: sucKeys,
        error_tipico_pct: r2((Math.exp(sigma) - 1) * 100),
        coeficientes: [
          ...Object.keys(iFac).map(f => ({
            variable: f,
            descripcion: DESCRIPCION[f],
            factor: Math.round(Math.exp(beta[iFac[f]]) * 1000) / 1000,
            prior: Math.round(Math.exp(params[iFac[f]].prior) * 1000) / 1000,
            dias_observados: nCond[f],
            fuente: nCond[f] === 0 ? 'prior' : 'aprendido',
          })),
          {
            variable: 'tendencia',
            descripcion: 'Tendencia mensual',
            factor: Math.round(Math.exp(beta[iTen]) * 1000) / 1000,
            prior: 1,
            dias_observados: diasDistintos,
            fuente: 'aprendido',
          },
        ],
        clima_pronostico_disponible: climaPronosticoOk,
      };

      predicciones = [];
      for (let k = 1; k <= HORIZONTE_DIAS; k++) {
        const f = sumarDias(hoy, k);
        const w = dowDe(f);
        const eventos = calendario[f] || [];
        const t = difDias(f, hoy) / 30;

        let valor = 0, min = 0, max = 0, tickets = 0, base = 0;
        const efectos = {};
        const climaPorSuc = {};

        sucKeys.forEach(sk => {
          let lb = beta[iInt] + (iSuc[sk] !== undefined ? beta[iSuc[sk]] : 0) + (w !== 0 ? beta[iDow[w]] : 0);
          let v = Math.exp(lb) * smear;
          base += v;

          const pasos = [];
          const pr = sk !== 'null' ? pronostico[Number(sk)]?.[f] : null;
          climaPorSuc[sk] = pr ? pr : { clima: 'desconocido' };
          if (pr && FACTORES_CLIMA.includes(pr.clima)) pasos.push([pr.clima, beta[iFac[pr.clima]]]);
          eventos.forEach(e => { if (iFac[e.tipo] !== undefined) pasos.push([e.tipo, beta[iFac[e.tipo]]]); });
          pasos.push(['tendencia', beta[iTen] * t]);

          pasos.forEach(([nombre, b]) => {
            const nuevo = v * Math.exp(b);
            efectos[nombre] = (efectos[nombre] || 0) + (nuevo - v);
            v = nuevo;
          });

          valor += v;
          min += v * Math.exp(-Z_RANGO * sigma);
          max += v * Math.exp(Z_RANGO * sigma);
          if (ticketProm[sk]) tickets += v / ticketProm[sk];
        });

        const listaEfectos = Object.keys(efectos)
          .filter(n => Math.abs(efectos[n]) >= 1)
          .map(n => ({ variable: n, descripcion: DESCRIPCION[n] || n, efecto_pesos: r0(efectos[n]) }));

        predicciones.push({
          fecha_target: f,
          dia_semana: NOMBRE_DIA[w],
          valor_predicho: r2(valor),
          rango_min: r0(min),
          rango_max: r0(max),
          tickets_esperados: r0(tickets),
          ticket_promedio: tickets > 0 ? r0(valor / tickets) : null,
          base_dia_semana: r0(base),
          dias_base: diasPorDow[w] || 0,
          efectos: listaEfectos,
          clima_pronostico: climaPorSuc,
          franjas: franjasPara(w, valor),
          confianza,
          horizonte: 'semana',
          senales_usadas: {
            modelo: 'condiciones',
            dias_datos: diasDistintos,
            base_dia_semana: r0(base),
            efectos: listaEfectos,
            clima_pronostico: climaPorSuc,
            eventos_contexto: eventos,
            intensidad_pais: eventos.length ? eventos.reduce((a, e) => a * e.intensidad, 1) : 1,
          },
        });
      }
    }
  }

  if (!predicciones) {
    // ─── 5b. Modelo simple (pocos días o falla numérica) ─────────────────────
    const porDia = {};
    obs.forEach(o => { porDia[o.dia] = (porDia[o.dia] || 0) + o.total; });
    const acum = {};
    Object.keys(porDia).forEach(d => {
      const w = dowDe(d);
      if (!acum[w]) acum[w] = { s: 0, n: 0 };
      acum[w].s += porDia[d]; acum[w].n += 1;
    });
    const totalGeneral = Object.values(porDia).reduce((a, v) => a + v, 0) / Object.keys(porDia).length;
    const tp = obs.reduce((a, o) => a + o.total, 0) / Math.max(1, obs.reduce((a, o) => a + o.tickets, 0));

    modelo = { tipo: 'simple', motivo: `menos de ${MIN_DIAS_MODELO} días con ventas`, dias_con_ventas: diasDistintos };
    predicciones = [];
    for (let k = 1; k <= HORIZONTE_DIAS; k++) {
      const f = sumarDias(hoy, k);
      const w = dowDe(f);
      const eventos = calendario[f] || [];
      const base = acum[w] ? acum[w].s / acum[w].n : totalGeneral;
      const intensidad = eventos.length ? eventos.reduce((a, e) => a * e.intensidad, 1) : 1;
      const valor = base * intensidad;
      predicciones.push({
        fecha_target: f,
        dia_semana: NOMBRE_DIA[w],
        valor_predicho: r2(valor),
        rango_min: r0(valor * 0.8),
        rango_max: r0(valor * 1.2),
        tickets_esperados: tp > 0 ? r0(valor / tp) : null,
        ticket_promedio: r0(tp),
        base_dia_semana: r0(base),
        dias_base: acum[w]?.n || 0,
        efectos: intensidad !== 1 ? [{ variable: 'calendario', descripcion: 'Calendario', efecto_pesos: r0(valor - base) }] : [],
        clima_pronostico: null,
        franjas: franjasPara(w, valor),
        confianza,
        horizonte: 'semana',
        senales_usadas: { modelo: 'simple', dias_datos: diasDistintos, eventos_contexto: eventos, intensidad_pais: intensidad },
      });
    }
  }

  // 6. Franjas de hoy (promedio por hora del mismo día de semana)
  const wHoy = dowDe(hoy);
  let franjas_hoy = null;
  if (perfilHora[wHoy] && diasPorDow[wHoy]) {
    const por_hora = Object.keys(perfilHora[wHoy]).map(Number).sort((a, b) => a - b)
      .map(h => ({ hora: h, promedio: r2(perfilHora[wHoy][h] / diasPorDow[wHoy]) }));
    franjas_hoy = {
      fecha: hoy,
      dia_semana: wHoy,
      dias_base: diasPorDow[wHoy],
      por_hora,
      hora_pico: por_hora.reduce((a, b) => (b.promedio > a.promedio ? b : a)),
      hora_floja: por_hora.reduce((a, b) => (b.promedio < a.promedio ? b : a)),
    };
  }

  // 7. Guardar una sola vez por día y sucursal
  if (guardar) {
    const existe = await db.query(
      `SELECT 1 FROM predicciones_negocio
       WHERE negocio_id = $1 AND sucursal_id IS NOT DISTINCT FROM $2::integer AND fecha_prediccion = $3
       LIMIT 1`,
      [negocio_id, sucursal_id, hoy]
    );
    if (existe.rows.length === 0) {
      for (const p of predicciones) {
        await db.query(
          `INSERT INTO predicciones_negocio
             (negocio_id, sucursal_id, fecha_prediccion, fecha_target, valor_predicho, confianza, senales_usadas, horizonte)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [negocio_id, sucursal_id, hoy, p.fecha_target, p.valor_predicho, p.confianza, JSON.stringify(p.senales_usadas), p.horizonte]
        );
      }
    }
  }

  const W1 = Math.min(diasDistintos / VENTANA_DIAS, 0.70); // compatibilidad con el frontend actual
  return {
    disponible: true,
    horizonte: 'semana',
    dias_datos: diasDistintos,
    confianza,
    pesos: { W1: Math.round(W1 * 1000) / 1000, W2: 0, W3: Math.round((1 - W1) * 1000) / 1000 },
    modelo,
    predicciones,
    total_fechas: predicciones.length,
    eventos_en_ventana: Object.keys(calendario).filter(d => d > hoy).length,
    franjas_hoy,
    fecha_prediccion: hoy,
    riesgo_contexto: riesgo_contexto ? {
      risk_score_final:     riesgo_contexto.risk_score_final,
      confirmacion_cruzada: riesgo_contexto.confirmacion_cruzada,
      debe_emitir:          riesgo_contexto.debe_emitir,
    } : null,
  };
}

module.exports = { calcularPrediccion, ownerDeNegocio };
