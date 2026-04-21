// cruce_variables.js — Lumo S7
// Motor de cruce de variables: detecta inconsistencias operativas
// cruzando caja, ventas, MP y egresos en cada turno.
//
// Fórmula central:
//   Efectivo esperado = Caja apertura + Ventas totales - Ventas MP - Egresos
//   Brecha = Efectivo esperado - Caja cierre declarada
//
// Un desvío de $500 deja 4 rastros simultáneos:
//   1. Brecha de caja
//   2. Ratio efectivo/ventas anómalo
//   3. Ticket promedio desviado
//   4. Cantidad de transacciones relativa

const pool = require('./db');
const { calcularMediana, calcularMAD, robustZScore } = require('./deteccion');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function redondear(n, dec = 0) {
  return Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec);
}

function calcularContextoTemporal(fecha) {
  const d = new Date(fecha);
  const dia = d.getDate();
  const diaSemana = d.getDay();
  return {
    quincena: dia <= 15 ? 1 : 2,
    es_dia_cobro: [1, 5, 15, 30].includes(dia),
    dia_semana: diaSemana,
    nombre_dia: ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][diaSemana],
  };
}

// ─── Análisis de un turno cerrado ────────────────────────────────────────────

async function analizarCruceTurno(turnoId) {
  // 1. Datos del turno
  const tRes = await pool.query('SELECT * FROM turnos_caja WHERE id=$1', [turnoId]);
  if (tRes.rows.length === 0) return { error: 'Turno no encontrado' };
  const t = tRes.rows[0];

  if (t.estado !== 'cerrado') return { error: 'El turno aún no está cerrado' };

  // 2. Egresos del turno
  const egresosRes = await pool.query(
    'SELECT COALESCE(SUM(monto),0) as total, COUNT(*) as cantidad FROM egresos_caja WHERE turno_id=$1',
    [turnoId]
  );
  const totalEgresos = parseFloat(egresosRes.rows[0].total);
  const cantEgresos = parseInt(egresosRes.rows[0].cantidad);

  // 3. Ventas del turno (por ventana temporal)
  const ventasRes = await pool.query(
    `SELECT
       COALESCE(SUM(monto),0) as total_ventas,
       COALESCE(SUM(CASE WHEN metodo_pago='mp' OR metodo_pago='digital' THEN monto ELSE 0 END),0) as total_mp,
       COUNT(*) as cantidad_tx,
       COALESCE(AVG(monto),0) as ticket_promedio
     FROM transacciones
     WHERE usuario_id=$1 AND fecha >= $2 AND fecha <= COALESCE($3, NOW())`,
    [t.usuario_id, t.hora_apertura, t.hora_cierre]
  );
  const v = ventasRes.rows[0];
  const totalVentas = parseFloat(v.total_ventas);
  const totalMP = parseFloat(v.total_mp);
  const cantidadTx = parseInt(v.cantidad_tx);
  const ticketPromedio = parseFloat(v.ticket_promedio);
  const totalEfectivo = totalVentas - totalMP;

  // 4. Fórmula central
  const cajaApertura = parseFloat(t.caja_apertura);
  const cajaCierre = parseFloat(t.caja_cierre);
  const efectivoEsperado = cajaApertura + totalVentas - totalMP - totalEgresos;
  const brecha = efectivoEsperado - cajaCierre;
  const brechaPct = efectivoEsperado > 0 ? (brecha / efectivoEsperado) * 100 : 0;

  // 5. Ratio efectivo/ventas
  const ratioEfectivo = totalVentas > 0 ? totalEfectivo / totalVentas : 0;

  // 6. Histórico del negocio para z-score
  const historico = await pool.query(
    `SELECT brecha, caja_esperada, nombre_empleado, tipo_turno, hora_apertura
     FROM turnos_caja
     WHERE usuario_id=$1 AND estado='cerrado' AND id != $2 AND brecha IS NOT NULL
     ORDER BY hora_apertura DESC LIMIT 60`,
    [t.usuario_id, turnoId]
  );
  const turnos = historico.rows;

  // 7. Z-score de la brecha vs histórico
  let zscoreBrecha = null;
  let gradoBrecha = 'sin_historico';
  if (turnos.length >= 5) {
    const brechas = turnos.map(r => parseFloat(r.brecha));
    const mediana = calcularMediana(brechas);
    const mad = calcularMAD(brechas, mediana);
    zscoreBrecha = robustZScore(brecha, mediana, mad);
    zscoreBrecha = redondear(zscoreBrecha, 2);

    if (Math.abs(zscoreBrecha) < 1.5) gradoBrecha = 'normal';
    else if (Math.abs(zscoreBrecha) < 2.5) gradoBrecha = 'atención';
    else if (Math.abs(zscoreBrecha) < 4.0) gradoBrecha = 'inconsistencia';
    else gradoBrecha = 'critico';
  }

  // 8. Señales activas (rastros del desvío)
  const señales = [];
  const umbralBrechaPct = 5; // 5% de tolerancia
  const umbralBrechaAbs = 1000; // $1000 ARS mínimo para emitir señal

  if (Math.abs(brecha) > umbralBrechaAbs && Math.abs(brechaPct) > umbralBrechaPct) {
    señales.push({
      tipo: 'BRECHA_CAJA',
      descripcion: brecha > 0 ? 'Falta efectivo en caja' : 'Hay efectivo de más',
      valor: redondear(brecha),
      peso: 'alto',
    });
  }

  if (zscoreBrecha !== null && Math.abs(zscoreBrecha) >= 2.0) {
    señales.push({
      tipo: 'ZSCORE_BRECHA',
      descripcion: `La brecha está ${redondear(Math.abs(zscoreBrecha), 1)} desvíos del patrón histórico`,
      valor: zscoreBrecha,
      peso: Math.abs(zscoreBrecha) >= 4.0 ? 'critico' : 'alto',
    });
  }

  // Cantidad de transacciones baja vs ventas (ventas altas con pocas tx = tickets inflados)
  if (cantidadTx > 0 && totalVentas > 0) {
    const ticketReal = totalVentas / cantidadTx;
    // Si ticket real es >2x el histórico sin causa → señal
    const txHistRes = await pool.query(
      `SELECT AVG(monto) as ticket_hist FROM transacciones
       WHERE usuario_id=$1 AND fecha >= NOW() - INTERVAL '60 days'`,
      [t.usuario_id]
    );
    const ticketHist = parseFloat(txHistRes.rows[0]?.ticket_hist || 0);
    if (ticketHist > 0 && ticketReal > ticketHist * 2.5) {
      señales.push({
        tipo: 'TICKET_INFLADO',
        descripcion: 'Ticket promedio del turno es inusualmente alto — pocas transacciones para las ventas declaradas',
        valor: redondear(ticketReal),
        peso: 'medio',
      });
    }
  }

  // Conteos omitidos como señal adicional
  if (t.conteo_aleatorio_omitido || t.conteo_aleatorio2_omitido) {
    señales.push({
      tipo: 'CONTEO_OMITIDO',
      descripcion: 'El empleado no respondió al conteo aleatorio en este turno',
      valor: null,
      peso: 'medio',
    });
  }

  // 9. Grado de inconsistencia basado en señales activas
  const numSeñales = señales.length;
  let gradoFinal = 'ok';
  if (numSeñales >= 3 || gradoBrecha === 'critico') gradoFinal = 'critico';
  else if (numSeñales === 2 || gradoBrecha === 'inconsistencia') gradoFinal = 'inconsistencia';
  else if (numSeñales === 1) gradoFinal = 'atencion';

  // Categoría de pérdida
  let categoria = null;
  if (gradoFinal !== 'ok') {
    if (t.conteo_aleatorio_omitido) categoria = 'error_operativo';
    else if (numSeñales >= 2) categoria = 'inconsistencia_operativa';
    else categoria = 'error_operativo';
  }

  const ctx = calcularContextoTemporal(t.hora_apertura);

  return {
    turno_id: turnoId,
    empleado: t.nombre_empleado,
    tipo_turno: t.tipo_turno,
    hora_apertura: t.hora_apertura,
    hora_cierre: t.hora_cierre,
    contexto: ctx,
    formula: {
      caja_apertura: cajaApertura,
      total_ventas: redondear(totalVentas),
      total_mp: redondear(totalMP),
      total_efectivo: redondear(totalEfectivo),
      total_egresos: redondear(totalEgresos),
      efectivo_esperado: redondear(efectivoEsperado),
      caja_cierre: cajaCierre,
      brecha: redondear(brecha),
      brecha_porcentaje: redondear(brechaPct, 1),
      ratio_efectivo: redondear(ratioEfectivo, 3),
      cantidad_tx: cantidadTx,
      ticket_promedio: redondear(ticketPromedio),
      egresos: cantEgresos,
    },
    zscore_brecha: zscoreBrecha,
    grado_brecha: gradoBrecha,
    señales,
    num_señales: numSeñales,
    grado_final: gradoFinal,
    categoria,
    turnos_historicos_usados: turnos.length,
  };
}

// ─── Detección de goteo (brechas acumuladas) ─────────────────────────────────

async function detectarGoteo(usuarioId, ventanaDias = 21) {
  const res = await pool.query(
    `SELECT id, nombre_empleado, tipo_turno, brecha, caja_esperada,
            hora_apertura, conteo_aleatorio_omitido, conteo_aleatorio2_omitido
     FROM turnos_caja
     WHERE usuario_id=$1 AND estado='cerrado' AND brecha IS NOT NULL
       AND hora_apertura >= NOW() - ($2 || ' days')::INTERVAL
     ORDER BY hora_apertura ASC`,
    [usuarioId, ventanaDias]
  );
  const turnos = res.rows;
  if (turnos.length < 3) return { detectado: false, motivo: 'datos_insuficientes', turnos_analizados: turnos.length };

  // Brecha total acumulada
  const brechaTotal = turnos.reduce((sum, t) => sum + parseFloat(t.brecha), 0);
  const brechaPromedio = brechaTotal / turnos.length;

  // Contar turnos con brecha significativa (>$500)
  const conBrecha = turnos.filter(t => Math.abs(parseFloat(t.brecha)) > 500);
  const pctBrecha = conBrecha.length / turnos.length;

  // Buscar patrones por empleado
  const porEmpleado = {};
  for (const t of conBrecha) {
    if (!porEmpleado[t.nombre_empleado]) {
      porEmpleado[t.nombre_empleado] = { turnos: 0, brecha_total: 0 };
    }
    porEmpleado[t.nombre_empleado].turnos += 1;
    porEmpleado[t.nombre_empleado].brecha_total += parseFloat(t.brecha);
  }

  // Buscar patrones por tipo de turno
  const porTurno = {};
  for (const t of conBrecha) {
    if (!porTurno[t.tipo_turno]) {
      porTurno[t.tipo_turno] = { turnos: 0, brecha_total: 0 };
    }
    porTurno[t.tipo_turno].turnos += 1;
    porTurno[t.tipo_turno].brecha_total += parseFloat(t.brecha);
  }

  // Determinar si hay goteo
  const umbralPct = 0.4; // 40% de turnos con brecha
  const umbralAcumulado = 5000; // $5000 ARS acumulados en 21 días
  const hayGoteo = pctBrecha >= umbralPct || Math.abs(brechaTotal) >= umbralAcumulado;

  // Patron dominante
  const patronEmpleado = Object.entries(porEmpleado)
    .sort((a, b) => b[1].turnos - a[1].turnos)[0];
  const patronTurno = Object.entries(porTurno)
    .sort((a, b) => b[1].turnos - a[1].turnos)[0];

  return {
    detectado: hayGoteo,
    ventana_dias: ventanaDias,
    turnos_analizados: turnos.length,
    turnos_con_brecha: conBrecha.length,
    porcentaje_con_brecha: redondear(pctBrecha * 100, 1),
    brecha_total_acumulada: redondear(brechaTotal),
    brecha_promedio_por_turno: redondear(brechaPromedio),
    patron_empleado: patronEmpleado
      ? { nombre: patronEmpleado[0], turnos: patronEmpleado[1].turnos, brecha: redondear(patronEmpleado[1].brecha_total) }
      : null,
    patron_turno: patronTurno
      ? { turno: patronTurno[0], turnos: patronTurno[1].turnos, brecha: redondear(patronTurno[1].brecha_total) }
      : null,
    // Nota para el dueño: sin nombrar empleado en alertas automáticas
    mensaje: !hayGoteo
      ? 'Sin patrón de goteo detectado'
      : Math.abs(brechaTotal) >= umbralAcumulado
        ? `Se acumularon ${Math.abs(redondear(brechaTotal)).toLocaleString('es-AR')} pesos de brecha en ${ventanaDias} días — patrón sostenido.`
        : `${conBrecha.length} de ${turnos.length} turnos tuvieron brecha — revisar turno ${patronTurno?.[0] || 'con más inconsistencias'}.`,
  };
}

// ─── Resumen de patrones históricos para el dueño ────────────────────────────

async function resumenPatronesNegocio(usuarioId, limiteTurnos = 30) {
  const res = await pool.query(
    `SELECT t.id, t.nombre_empleado, t.tipo_turno, t.brecha, t.caja_esperada,
            t.hora_apertura, t.hora_cierre,
            t.conteo_aleatorio_omitido, t.conteo_aleatorio2_omitido,
            (SELECT COUNT(*) FROM egresos_caja e WHERE e.turno_id=t.id) as num_egresos
     FROM turnos_caja t
     WHERE t.usuario_id=$1 AND t.estado='cerrado' AND t.brecha IS NOT NULL
     ORDER BY t.hora_apertura DESC LIMIT $2`,
    [usuarioId, limiteTurnos]
  );
  const turnos = res.rows;
  if (turnos.length === 0) return { turnos_analizados: 0, patrones: [] };

  const brechas = turnos.map(t => parseFloat(t.brecha));
  const mediana = calcularMediana(brechas);
  const mad = calcularMAD(brechas, mediana);

  const turnosConScore = turnos.map(t => {
    const brecha = parseFloat(t.brecha);
    const zscore = mad > 0 ? robustZScore(brecha, mediana, mad) : 0;
    return {
      turno_id: t.id,
      empleado: t.nombre_empleado,
      tipo_turno: t.tipo_turno,
      fecha: new Date(t.hora_apertura).toISOString().slice(0, 10),
      brecha: redondear(brecha),
      zscore_brecha: redondear(zscore, 2),
      grado: Math.abs(zscore) >= 4 ? 'critico' : Math.abs(zscore) >= 2.5 ? 'inconsistencia' : Math.abs(zscore) >= 1.5 ? 'atencion' : 'ok',
      conteo_omitido: t.conteo_aleatorio_omitido || t.conteo_aleatorio2_omitido,
      num_egresos: parseInt(t.num_egresos),
    };
  });

  // Agrupados por tipo de turno
  const porTipoTurno = {};
  for (const t of turnosConScore) {
    if (!porTipoTurno[t.tipo_turno]) {
      porTipoTurno[t.tipo_turno] = { turnos: 0, brecha_total: 0, inconsistencias: 0 };
    }
    porTipoTurno[t.tipo_turno].turnos += 1;
    porTipoTurno[t.tipo_turno].brecha_total += t.brecha;
    if (t.grado !== 'ok') porTipoTurno[t.tipo_turno].inconsistencias += 1;
  }

  // Rachas limpias (turnos sin brecha significativa consecutivos)
  let rachaActual = 0;
  let rachaMax = 0;
  for (const t of [...turnosConScore].reverse()) {
    if (t.grado === 'ok') { rachaActual++; rachaMax = Math.max(rachaMax, rachaActual); }
    else rachaActual = 0;
  }

  return {
    turnos_analizados: turnos.length,
    mediana_brecha: redondear(mediana),
    turnos: turnosConScore,
    por_tipo_turno: Object.entries(porTipoTurno).map(([tipo, d]) => ({
      tipo_turno: tipo,
      ...d,
      brecha_total: redondear(d.brecha_total),
      tasa_inconsistencia: redondear((d.inconsistencias / d.turnos) * 100, 1),
    })),
    racha_limpia_actual: rachaActual,
    racha_limpia_maxima: rachaMax,
  };
}

module.exports = { analizarCruceTurno, detectarGoteo, resumenPatronesNegocio };
