// zscore_contextual.js — Lumo S7
// Z-score con contexto temporal completo.
//
// Dimensiones de contexto:
//   - Turno (mañana/tarde/noche)
//   - Día de semana
//   - Quincena (1-15 vs 16-30)
//   - Días de cobro (1, 5, 15, 30)
//   - Feriado (tabla 2026 hardcodeada)
//   - Clima vía Open-Meteo (lluvia/calor/frío)
//
// Jerarquía de 5 niveles para lookup de peers:
//   turno+día+quincena → turno+día → turno → día → global
//
// Confianza por n de observaciones:
//   <10 → sin score    10-19 → 65%    20-39 → 80%    40+ → 95%

const pool = require('./db');
const https = require('https');
const { calcularMediana, calcularMAD, robustZScore } = require('./deteccion');

const DEFAULT_LAT_CABA = -34.6037;
const DEFAULT_LON_CABA = -58.3816;

// ─── Feriados Argentina 2026 ─────────────────────────────────────────────────

const FERIADOS_ARG = new Set([
  // 2025
  '2025-01-01','2025-03-03','2025-03-04','2025-03-24','2025-04-02',
  '2025-04-18','2025-04-19','2025-05-01','2025-05-25','2025-06-16',
  '2025-06-20','2025-07-09','2025-08-18','2025-10-13','2025-11-20',
  '2025-11-24','2025-12-08','2025-12-25',
  // 2026
  '2026-01-01','2026-02-16','2026-02-17','2026-03-24','2026-04-02',
  '2026-04-03','2026-04-04','2026-05-01','2026-05-25','2026-06-15',
  '2026-06-20','2026-07-09','2026-08-17','2026-10-12','2026-11-20',
  '2026-11-23','2026-12-08','2026-12-25',
]);

// ─── Contexto temporal ────────────────────────────────────────────────────────

function getContextoTemporal(fecha) {
  // Normalizar a hora Argentina (UTC-3) independientemente del servidor
  const d = new Date(fecha);
  const dAR = new Date(d.getTime() - 3 * 60 * 60 * 1000); // UTC → AR
  const dia = dAR.getUTCDate();
  const diaSemana = dAR.getUTCDay(); // 0=Dom … 6=Sáb
  const hora = dAR.getUTCHours();
  const fechaStr = dAR.toISOString().slice(0, 10);

  let turno;
  if (hora >= 6 && hora < 14) turno = 'manana';
  else if (hora >= 14 && hora < 22) turno = 'tarde';
  else turno = 'noche';

  return {
    fecha_str: fechaStr,
    turno,
    dia_semana: diaSemana,
    nombre_dia: ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][diaSemana],
    es_fin_semana: diaSemana === 0 || diaSemana === 6,
    quincena: dia <= 15 ? 1 : 2,
    es_dia_cobro: [1, 5, 15, 30].includes(dia),
    es_feriado: FERIADOS_ARG.has(fechaStr),
    mes: d.getMonth() + 1,
    dia,
  };
}

// Clave de contexto para buscar peers — de más específico a más general
function clavesContexto(ctx) {
  return [
    `${ctx.turno}_d${ctx.dia_semana}_q${ctx.quincena}`,  // turno+día+quincena
    `${ctx.turno}_d${ctx.dia_semana}`,                    // turno+día
    `${ctx.turno}`,                                        // turno
    `d${ctx.dia_semana}`,                                  // día semana
    'global',                                              // global
  ];
}

// Factores de ajuste multiplicativos por contexto
// El baseline se ajusta ANTES de calcular el z-score
function factoresAjuste(ctx, clima, indiceInflacion = null) {
  let factor = 1.0;
  const componentes = [];

  if (ctx.es_feriado) {
    factor *= 0.65; // los feriados bajan ventas ~35%
    componentes.push({ causa: 'feriado', ajuste: -0.35 });
  }
  if (ctx.es_fin_semana && !ctx.es_feriado) {
    factor *= 1.20; // fin de semana sube ~20%
    componentes.push({ causa: 'fin_de_semana', ajuste: 0.20 });
  }
  if (ctx.es_dia_cobro) {
    factor *= 1.15; // día de cobro sube ~15%
    componentes.push({ causa: 'dia_cobro', ajuste: 0.15 });
  }
  if (ctx.quincena === 2 && ctx.dia >= 26) {
    factor *= 0.90; // fin de quincena baja ~10%
    componentes.push({ causa: 'fin_quincena', ajuste: -0.10 });
  }

  // Clima
  if (clima === 'lluvia') {
    factor *= 0.80;
    componentes.push({ causa: 'lluvia', ajuste: -0.20 });
  } else if (clima === 'calor_extremo') {
    factor *= 0.85;
    componentes.push({ causa: 'calor_extremo', ajuste: -0.15 });
  }

  // Interacción lluvia + feriado (no es suma lineal)
  if (ctx.es_feriado && clima === 'lluvia') {
    factor *= 0.90; // doble impacto: 0.65 × 0.80 × 0.90 = 0.468
    componentes.push({ causa: 'lluvia_x_feriado', ajuste: -0.10 });
  }

  // Inflación mensual (cuando está disponible)
  if (indiceInflacion !== null && indiceInflacion !== 0) {
    const factorInflacion = 1 + (indiceInflacion / 100);
    factor *= factorInflacion;
    componentes.push({ causa: 'inflacion_mensual', ajuste: Math.round(indiceInflacion) / 100 });
  }

  return { factor: Math.round(factor * 1000) / 1000, componentes };
}

// ─── Clima vía Open-Meteo ─────────────────────────────────────────────────────
// Buenos Aires: lat=-34.6037, lon=-58.3816
// API gratuita, sin key. Timeout de 3 segundos para no bloquear.

async function resolverCoordenadasSucursal(negocioId, sucursalId) {
  if (sucursalId) {
    const r = await pool.query(
      `SELECT latitud, longitud FROM mis_sucursales
       WHERE id=$1 AND negocio_id=$2 AND geocoding_status='ok'`,
      [sucursalId, negocioId]
    );
    if (r.rows.length > 0) return {
      lat: parseFloat(r.rows[0].latitud),
      lon: parseFloat(r.rows[0].longitud),
      sucursal_id: sucursalId
    };
  }
  // Fallback: primera sucursal geocodificada del negocio
  const r2 = await pool.query(
    `SELECT id, latitud, longitud FROM mis_sucursales
     WHERE negocio_id=$1 AND geocoding_status='ok'
     ORDER BY id ASC LIMIT 1`,
    [negocioId]
  );
  if (r2.rows.length > 0) return {
    lat: parseFloat(r2.rows[0].latitud),
    lon: parseFloat(r2.rows[0].longitud),
    sucursal_id: r2.rows[0].id
  };
  return null; // ninguna sucursal geocodificada todavía
}

const _climaCache = {}; // { 'YYYY-MM-DD_lat_lon': { clima, timestamp } }

async function fetchClima(fechaStr, lat, lon, sucursalId) {
  // Default temporal: se usa cuando no hay sucursal geocodificada todavía,
  // o desde código no conectado (predicciones.js)
  const latFinal = (lat == null || lat === undefined) ? DEFAULT_LAT_CABA : lat;
  const lonFinal = (lon == null || lon === undefined) ? DEFAULT_LON_CABA : lon;

  // Cache por día + ubicación
  const cacheKey = `${fechaStr}_${latFinal.toFixed(2)}_${lonFinal.toFixed(2)}`;
  if (_climaCache[cacheKey] && (Date.now() - _climaCache[cacheKey].ts) < 6 * 3600 * 1000) {
    return _climaCache[cacheKey].clima;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('desconocido'), 3000);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latFinal}&longitude=${lonFinal}&daily=precipitation_sum,temperature_2m_max&timezone=America%2FArgentina%2FBuenos_Aires&start_date=${fechaStr}&end_date=${fechaStr}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(data);
          const precip = json.daily?.precipitation_sum?.[0] ?? 0;
          const tempMax = json.daily?.temperature_2m_max?.[0] ?? 20;
          let clima = 'normal';
          if (precip >= 5) clima = 'lluvia';
          else if (tempMax >= 35) clima = 'calor_extremo';
          else if (tempMax <= 5) clima = 'frio_extremo';
          _climaCache[cacheKey] = { clima, ts: Date.now() };

          // Guardar en clima_historico si tenemos sucursal_id (fire-and-forget)
          if (sucursalId != null && sucursalId !== undefined) {
            pool.query(
              `INSERT INTO clima_historico(sucursal_id, fecha, clima, precipitacion_mm, temp_max)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT (sucursal_id, fecha) DO NOTHING`,
              [sucursalId, fechaStr, clima, precip, tempMax]
            ).catch(() => {}); // fire-and-forget, no romper si falla el INSERT
          }

          resolve(clima);
        } catch {
          resolve('desconocido');
        }
      });
    }).on('error', () => { clearTimeout(timeout); resolve('desconocido'); });
  });
}

// ─── Z-score propio del empleado ─────────────────────────────────────────────
// Compara el empleado consigo mismo en el mismo tipo de turno.
// Mínimo 10 turnos. Confianza dinámica por n.

async function calcularZScoreEmpleado(negocioId, nombreEmpleado, tipoTurno, brechaActual) {
  const res = await pool.query(
    `SELECT brecha FROM turnos_caja
     WHERE negocio_id=$1 AND nombre_empleado=$2 AND tipo_turno=$3
       AND estado='cerrado' AND brecha IS NOT NULL
     ORDER BY hora_apertura DESC LIMIT 60`,
    [negocioId, nombreEmpleado, tipoTurno]
  );

  const n = res.rows.length;
  if (n < 10) return { zscore: null, confianza: 0, n, nivel: 'sin_score' };

  const confianza = n < 20 ? 65 : n < 40 ? 80 : 95;
  const valores = res.rows.map(r => parseFloat(r.brecha));
  const mediana = calcularMediana(valores);
  const mad = calcularMAD(valores, mediana);

  if (mad === 0) return { zscore: 0, confianza, n, nivel: 'sin_variacion' };

  const zscore = parseFloat(robustZScore(brechaActual, mediana, mad).toFixed(2));
  const nivel = Math.abs(zscore) >= 4 ? 'critico' : Math.abs(zscore) >= 2.5 ? 'inconsistencia' : Math.abs(zscore) >= 1.5 ? 'atencion' : 'normal';

  return { zscore, confianza, n, nivel, mediana: Math.round(mediana), mad: Math.round(mad) };
}

// ─── Ranking de empleados por tipo de turno ───────────────────────────────────
// Compara empleados entre sí dentro del mismo tipo de turno.
// No compara números crudos — normaliza por historial propio.
// NUNCA nombra al empleado en alertas automáticas.

async function rankingEmpleadosTurno(negocioId, tipoTurno, ventanaDias = 30) {
  const res = await pool.query(
    `SELECT nombre_empleado,
            COUNT(*) as n_turnos,
            AVG(ABS(COALESCE(brecha, 0))) as brecha_promedio_abs,
            AVG(COALESCE(brecha, 0)) as brecha_promedio,
            SUM(CASE WHEN ABS(COALESCE(brecha,0)) > 1000 THEN 1 ELSE 0 END) as turnos_con_brecha,
            SUM(CASE WHEN conteo_aleatorio_omitido = true THEN 1 ELSE 0 END) as conteos_omitidos
     FROM turnos_caja
     WHERE negocio_id=$1 AND tipo_turno=$2 AND estado='cerrado'
       AND hora_apertura >= NOW() - ($3 || ' days')::INTERVAL
     GROUP BY nombre_empleado
     HAVING COUNT(*) >= 3
     ORDER BY brecha_promedio_abs ASC`,
    [negocioId, tipoTurno, ventanaDias]
  );

  if (res.rows.length < 2) return null; // sin peers suficientes

  const empleados = res.rows.map((r, i) => {
    const n = parseInt(r.n_turnos);
    const brechaAbs = parseFloat(r.brecha_promedio_abs);
    const tasaBrecha = parseInt(r.turnos_con_brecha) / n;
    const tasaOmision = parseInt(r.conteos_omitidos) / n;

    // Score 0-100: menor brecha + menor tasa inconsistencia + menor omisión
    const brechaMax = parseFloat(res.rows[res.rows.length - 1].brecha_promedio_abs) || 1;
    const score = Math.max(0, Math.round(
      100
      - (brechaAbs / brechaMax) * 50
      - tasaBrecha * 30
      - tasaOmision * 20
    ));

    return {
      nombre: r.nombre_empleado,
      n_turnos: n,
      brecha_promedio: Math.round(parseFloat(r.brecha_promedio)),
      brecha_promedio_abs: Math.round(brechaAbs),
      tasa_inconsistencia: Math.round(tasaBrecha * 100),
      conteos_omitidos: parseInt(r.conteos_omitidos),
      score,
      posicion: i + 1,
    };
  });

  return {
    tipo_turno: tipoTurno,
    ventana_dias: ventanaDias,
    empleados,
    nota: 'Ranking dentro del mismo tipo de turno. Menor brecha = mejor score.',
  };
}

// ─── Análisis completo de un turno con contexto temporal ─────────────────────

async function analizarTurnoConContexto(turnoId) {
  const tRes = await pool.query('SELECT * FROM turnos_caja WHERE id=$1', [turnoId]);
  if (tRes.rows.length === 0) return { error: 'Turno no encontrado' };
  const t = tRes.rows[0];
  if (t.estado !== 'cerrado') return { error: 'El turno aún no está cerrado' };

  const ctx = getContextoTemporal(t.hora_apertura);
  const coords = await resolverCoordenadasSucursal(t.negocio_id, t.sucursal_id);
  const clima = await fetchClima(ctx.fecha_str, coords?.lat, coords?.lon, coords?.sucursal_id);
  const { factor, componentes } = factoresAjuste(ctx, clima);

  // Brecha ajustada por contexto
  const brecha = parseFloat(t.brecha || 0);
  const cajaEsperada = parseFloat(t.caja_esperada || 0);
  // La brecha esperada en un contexto anómalo (feriado, lluvia) puede ser mayor
  // — si el negocio tiene historial, el baseline ya lo contempla.
  // Usamos el factor como referencia para contextualizar la evaluación.
  const brechaContextualizada = cajaEsperada > 0
    ? brecha / (cajaEsperada * factor) // brecha relativa ajustada
    : brecha;

  // Z-score propio del empleado
  const zEmpleado = await calcularZScoreEmpleado(
    t.negocio_id, t.nombre_empleado, t.tipo_turno, brecha
  );

  // Ranking de peers (para la pantalla Equipo del dueño)
  const ranking = await rankingEmpleadosTurno(t.negocio_id, t.tipo_turno, 30);

  // Posición en el ranking
  let posicionRanking = null;
  if (ranking) {
    const pos = ranking.empleados.find(e => e.nombre === t.nombre_empleado);
    posicionRanking = pos ? { posicion: pos.posicion, score: pos.score, total: ranking.empleados.length } : null;
  }

  // Mensajes positivos (cuenta turnos limpios consecutivos del empleado)
  const rachaRes = await pool.query(
    `SELECT id, ABS(COALESCE(brecha,0)) as brecha_abs
     FROM turnos_caja
     WHERE negocio_id=$1 AND nombre_empleado=$2 AND tipo_turno=$3 AND estado='cerrado'
     ORDER BY hora_apertura DESC LIMIT 15`,
    [t.negocio_id, t.nombre_empleado, t.tipo_turno]
  );
  let rachaLimpia = 0;
  for (const r of rachaRes.rows) {
    if (parseFloat(r.brecha_abs) <= 1000) rachaLimpia++;
    else break;
  }

  const mensajePositivo = generarMensajePositivo(t.nombre_empleado, rachaLimpia);

  return {
    turno_id: turnoId,
    empleado: t.nombre_empleado,
    tipo_turno: t.tipo_turno,
    fecha: ctx.fecha_str,
    contexto: {
      ...ctx,
      clima,
      factor_ajuste: factor,
      componentes_ajuste: componentes,
    },
    brecha,
    brecha_contextualizada: parseFloat(brechaContextualizada.toFixed(4)),
    zscore_empleado: zEmpleado,
    ranking_turno: posicionRanking,
    racha_limpia: rachaLimpia,
    mensaje_positivo: mensajePositivo,
  };
}

// ─── Mensajes positivos ───────────────────────────────────────────────────────
// Regla: 1 turno limpio → nada / 3 → mención / 7 → celebración / 14+ → destacado

function generarMensajePositivo(nombre, rachaLimpia) {
  if (rachaLimpia >= 14) {
    return {
      nivel: 'destacado',
      texto: `${rachaLimpia} turnos consecutivos sin inconsistencias. Excelente gestión sostenida.`,
      mostrar: true,
    };
  }
  if (rachaLimpia >= 7) {
    return {
      nivel: 'celebracion',
      texto: `7 días sin inconsistencias. El turno está en racha positiva.`,
      mostrar: true,
    };
  }
  if (rachaLimpia >= 3) {
    return {
      nivel: 'mencion',
      texto: `3 turnos seguidos sin desvíos.`,
      mostrar: true,
    };
  }
  return { nivel: 'ninguno', texto: null, mostrar: false };
}

// ─── Análisis de turno activo (sin cierre) ───────────────────────────────────
// Para mostrar contexto en la pantalla del dueño mientras el turno corre.

async function contextTurnoActivo(negocioId, tipoTurno) {
  const ahora = new Date();
  const ctx = getContextoTemporal(ahora);
  const coords = await resolverCoordenadasSucursal(negocioId, null);
  const clima = await fetchClima(ctx.fecha_str, coords?.lat, coords?.lon, coords?.sucursal_id);
  const { factor, componentes } = factoresAjuste(ctx, clima);

  // Ticket esperado del turno según contexto
  const baselineRes = await pool.query(
    `SELECT AVG(caja_esperada) as venta_media
     FROM turnos_caja
     WHERE negocio_id=$1 AND tipo_turno=$2 AND estado='cerrado'
       AND hora_apertura >= NOW() - INTERVAL '60 days'`,
    [negocioId, tipoTurno]
  );
  const ventaMedia = parseFloat(baselineRes.rows[0]?.venta_media || 0);
  const ventaEsperadaHoy = Math.round(ventaMedia * factor);

  return {
    contexto: { ...ctx, clima, factor_ajuste: factor, componentes_ajuste: componentes },
    venta_esperada_turno: ventaEsperadaHoy,
    venta_media_historica: Math.round(ventaMedia),
    nota: componentes.length > 0
      ? `Ajuste por: ${componentes.map(c => c.causa).join(', ')}`
      : 'Sin factores de ajuste aplicados',
  };
}

// ─── Detección de cambio de comportamiento (titular vs reemplazo) ─────────────

async function detectarCambioComportamiento(negocioId, nombreEmpleado, tipoTurno) {
  // Turnos recientes del empleado vs turnos del mismo slot con otros empleados
  const [propios, otros] = await Promise.all([
    pool.query(
      `SELECT brecha FROM turnos_caja
       WHERE negocio_id=$1 AND nombre_empleado=$2 AND tipo_turno=$3
         AND estado='cerrado' AND brecha IS NOT NULL
       ORDER BY hora_apertura DESC LIMIT 20`,
      [negocioId, nombreEmpleado, tipoTurno]
    ),
    pool.query(
      `SELECT brecha FROM turnos_caja
       WHERE negocio_id=$1 AND nombre_empleado!=$2 AND tipo_turno=$3
         AND estado='cerrado' AND brecha IS NOT NULL
       ORDER BY hora_apertura DESC LIMIT 40`,
      [negocioId, nombreEmpleado, tipoTurno]
    ),
  ]);

  if (propios.rows.length < 5 || otros.rows.length < 5) {
    return { detectado: false, motivo: 'datos_insuficientes' };
  }

  const brechasPropias = propios.rows.map(r => parseFloat(r.brecha));
  const brechasOtros = otros.rows.map(r => parseFloat(r.brecha));

  const medianaPropia = calcularMediana(brechasPropias);
  const medianaOtros = calcularMediana(brechasOtros);
  const madOtros = calcularMAD(brechasOtros, medianaOtros);

  if (madOtros === 0) return { detectado: false, motivo: 'sin_variacion_peers' };

  // Z-score del comportamiento propio vs peers
  const zVsPeers = parseFloat(robustZScore(medianaPropia, medianaOtros, madOtros).toFixed(2));

  return {
    detectado: Math.abs(zVsPeers) >= 2.0,
    zscore_vs_peers: zVsPeers,
    mediana_propia: Math.round(medianaPropia),
    mediana_peers: Math.round(medianaOtros),
    n_propios: propios.rows.length,
    n_peers: otros.rows.length,
    direccion: zVsPeers > 0 ? 'brechas_mayores_que_peers' : 'brechas_menores_que_peers',
  };
}

module.exports = {
  getContextoTemporal,
  clavesContexto,
  factoresAjuste,
  resolverCoordenadasSucursal,
  fetchClima,
  calcularZScoreEmpleado,
  rankingEmpleadosTurno,
  analizarTurnoConContexto,
  generarMensajePositivo,
  contextTurnoActivo,
  detectarCambioComportamiento,
  FERIADOS_ARG,
};
