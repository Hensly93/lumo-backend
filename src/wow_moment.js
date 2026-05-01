const pool = require('./db');

/**
 * Calcula "wow moments" — patrones impactantes del negocio basados en últimos 30 días
 * Devuelve top 3 patrones ordenados por impacto en pesos
 */
async function calculateWowMoment(usuario_id, db = pool) {
  try {
    // Obtener tipo_negocio para benchmarks
    const userRes = await db.query('SELECT tipo_negocio FROM usuarios WHERE id=$1', [usuario_id]);
    const tipo_negocio = userRes.rows[0]?.tipo_negocio || 'otros';

    // Obtener transacciones últimos 30 días
    const txRes = await db.query(
      `SELECT monto, metodo_pago, fecha, turno
       FROM transacciones
       WHERE usuario_id=$1 AND fecha >= NOW() - INTERVAL '30 days'
       ORDER BY fecha ASC`,
      [usuario_id]
    );

    const transacciones = txRes.rows;
    if (transacciones.length < 10) {
      return { patrones: [], mensaje: 'Necesitás al menos 10 transacciones en los últimos 30 días para ver patrones.' };
    }

    const patrones = [];

    // ─── PATTERN A: Mejor/peor día de semana ───────────────────────────────────
    const porDia = {};
    transacciones.forEach(tx => {
      const dia = new Date(tx.fecha).getDay(); // 0=Dom, 6=Sáb
      if (!porDia[dia]) porDia[dia] = [];
      porDia[dia].push(parseFloat(tx.monto));
    });

    const diasConDatos = Object.keys(porDia).filter(d => porDia[d].length >= 3);
    if (diasConDatos.length >= 2) {
      const promedios = diasConDatos.map(d => {
        const montos = porDia[d];
        const promedio = montos.reduce((a, b) => a + b, 0) / montos.length;
        return { dia: parseInt(d), promedio, count: montos.length };
      });

      promedios.sort((a, b) => b.promedio - a.promedio);
      const mejor = promedios[0];
      const peor = promedios[promedios.length - 1];
      const diferencia = mejor.promedio - peor.promedio;
      const pctDiff = ((diferencia / peor.promedio) * 100).toFixed(0);

      const DIAS_NOMBRE = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
      const impacto_mensual = diferencia * 4; // ~4 veces al mes

      patrones.push({
        id: 'dia_semana',
        icono: '📅',
        titulo: `${DIAS_NOMBRE[mejor.dia]} vende ${pctDiff}% más que ${DIAS_NOMBRE[peor.dia]}`,
        descripcion: `En promedio, ${DIAS_NOMBRE[mejor.dia]} genera $${Math.round(mejor.promedio).toLocaleString('es-AR')} mientras que ${DIAS_NOMBRE[peor.dia]} solo $${Math.round(peor.promedio).toLocaleString('es-AR')}. La diferencia por día es de $${Math.round(diferencia).toLocaleString('es-AR')}.`,
        duele: `Perdés $${Math.round(impacto_mensual).toLocaleString('es-AR')} al mes en días flojos`,
        recomendacion: `Reforzá el personal o hacé promo los ${DIAS_NOMBRE[peor.dia]} para equiparar ventas.`,
        advertencia: 'Este es un análisis preliminar. NICOLE está estudiando el comportamiento de tu negocio. Con más datos, la precisión mejora.',
        impacto_pesos: impacto_mensual,
        confianza: Math.min(95, 50 + (diasConDatos.length * 8)),
        detalle: {
          mejor_dia: DIAS_NOMBRE[mejor.dia],
          mejor_promedio: Math.round(mejor.promedio),
          peor_dia: DIAS_NOMBRE[peor.dia],
          peor_promedio: Math.round(peor.promedio),
          diferencia_diaria: Math.round(diferencia),
          transacciones_analizadas: transacciones.length,
        },
      });
    }

    // ─── PATTERN B: Mejor/peor turno ───────────────────────────────────────────
    const porTurno = { manana: [], tarde: [], noche: [] };
    transacciones.forEach(tx => {
      const hora = new Date(tx.fecha).getHours();
      const monto = parseFloat(tx.monto);
      if (hora >= 6 && hora < 12) porTurno.manana.push(monto);
      else if (hora >= 12 && hora < 18) porTurno.tarde.push(monto);
      else if (hora >= 18 && hora < 24) porTurno.noche.push(monto);
    });

    const turnosConDatos = Object.keys(porTurno).filter(t => porTurno[t].length >= 3);
    if (turnosConDatos.length >= 2) {
      const turnos = turnosConDatos.map(t => {
        const montos = porTurno[t];
        const total = montos.reduce((a, b) => a + b, 0);
        const promedio = total / montos.length;
        return { turno: t, total, promedio, count: montos.length };
      });

      turnos.sort((a, b) => b.total - a.total);
      const mejor = turnos[0];
      const peor = turnos[turnos.length - 1];
      const gap = mejor.total - peor.total;

      const TURNO_NOMBRE = { manana: 'Mañana', tarde: 'Tarde', noche: 'Noche' };
      const impacto_mensual = gap; // gap en el período de 30 días

      patrones.push({
        id: 'turno_peak',
        icono: '⏰',
        titulo: `${TURNO_NOMBRE[mejor.turno]} genera $${Math.round(gap).toLocaleString('es-AR')} más que ${TURNO_NOMBRE[peor.turno]}`,
        descripcion: `Turno ${TURNO_NOMBRE[mejor.turno]} vendió $${Math.round(mejor.total).toLocaleString('es-AR')} en 30 días (${mejor.count} transacciones) vs ${TURNO_NOMBRE[peor.turno]} con solo $${Math.round(peor.total).toLocaleString('es-AR')} (${peor.count} transacciones). Ticket promedio ${TURNO_NOMBRE[mejor.turno]}: $${Math.round(mejor.promedio).toLocaleString('es-AR')}.`,
        duele: `El turno ${TURNO_NOMBRE[peor.turno]} está dejando $${Math.round(gap).toLocaleString('es-AR')} en la mesa`,
        recomendacion: `Optimizá horarios del turno ${TURNO_NOMBRE[peor.turno]} o concentrá recursos en ${TURNO_NOMBRE[mejor.turno]}.`,
        advertencia: 'Este es un análisis preliminar. NICOLE está estudiando el comportamiento de tu negocio. Con más datos, la precisión mejora.',
        impacto_pesos: impacto_mensual,
        confianza: Math.min(90, 45 + (turnosConDatos.length * 15)),
        detalle: {
          mejor_turno: TURNO_NOMBRE[mejor.turno],
          mejor_total: Math.round(mejor.total),
          mejor_avg_ticket: Math.round(mejor.promedio),
          peor_turno: TURNO_NOMBRE[peor.turno],
          peor_total: Math.round(peor.total),
          gap_pesos: Math.round(gap),
        },
      });
    }

    // ─── PATTERN C: Efectivo vs Digital (vs benchmark sector) ──────────────────
    let totalEfectivo = 0;
    let totalDigital = 0;
    transacciones.forEach(tx => {
      const monto = parseFloat(tx.monto);
      const metodo = (tx.metodo_pago || '').toLowerCase();
      if (metodo.includes('efectivo') || metodo === 'cash') {
        totalEfectivo += monto;
      } else {
        totalDigital += monto;
      }
    });

    const totalGeneral = totalEfectivo + totalDigital;
    if (totalGeneral > 0) {
      const pctEfectivo = (totalEfectivo / totalGeneral) * 100;
      const pctDigital = (totalDigital / totalGeneral) * 100;

      // Benchmarks sector
      const benchmarks = {
        cafeteria: 45,
        kiosko: 85,
        restaurante: 40,
        almacen: 70,
        otros: 60,
      };
      const benchmark = benchmarks[tipo_negocio] || benchmarks.otros;
      const desviacion = Math.abs(pctEfectivo - benchmark);

      if (desviacion > 15) {
        const mensaje = pctEfectivo > benchmark
          ? `Tenés ${pctEfectivo.toFixed(0)}% en efectivo vs ${benchmark}% del sector. Exceso de efectivo aumenta riesgo de hurtos.`
          : `Solo ${pctEfectivo.toFixed(0)}% efectivo vs ${benchmark}% del sector. Podés estar perdiendo clientes sin medios digitales.`;

        // Estimar impacto: si estás muy arriba, perdida por hurtos ~2% del efectivo excedente
        // Si estás muy abajo, perdida por rechazo de ventas ~5% de lo que falta
        const exceso = pctEfectivo - benchmark;
        const impacto = exceso > 0
          ? (totalEfectivo * 0.02) // 2% riesgo hurto
          : (totalGeneral * Math.abs(exceso) / 100 * 0.05); // 5% ventas perdidas

        patrones.push({
          id: 'efectivo_digital',
          icono: '💳',
          titulo: pctEfectivo > benchmark ? 'Demasiado efectivo en caja' : 'Muy poco efectivo aceptado',
          descripcion: mensaje,
          duele: pctEfectivo > benchmark
            ? `El exceso de efectivo te expone a perder $${Math.round(impacto).toLocaleString('es-AR')} al mes por hurtos`
            : `Rechazás $${Math.round(impacto).toLocaleString('es-AR')} en ventas al mes por falta de efectivo`,
          recomendacion: pctEfectivo > benchmark
            ? 'Implementá controles de caja más frecuentes y depositá a diario.'
            : 'Aceptá efectivo para no perder clientes que solo tienen cash.',
          advertencia: 'Este es un análisis preliminar. NICOLE está estudiando el comportamiento de tu negocio. Con más datos, la precisión mejora.',
          impacto_pesos: impacto,
          confianza: 75,
          detalle: {
            pct_efectivo: pctEfectivo.toFixed(1),
            pct_digital: pctDigital.toFixed(1),
            benchmark_sector: benchmark,
            desviacion: desviacion.toFixed(1),
            total_efectivo: Math.round(totalEfectivo),
            total_digital: Math.round(totalDigital),
          },
        });
      }
    }

    // ─── PATTERN D: Tendencia semana a semana ───────────────────────────────────
    const ahora = new Date();
    const semanas = [[], [], [], []]; // últimas 4 semanas
    transacciones.forEach(tx => {
      const fecha = new Date(tx.fecha);
      const diasAtras = Math.floor((ahora - fecha) / (1000 * 60 * 60 * 24));
      const semanaIdx = Math.floor(diasAtras / 7);
      if (semanaIdx < 4) {
        semanas[3 - semanaIdx].push(parseFloat(tx.monto)); // 3=más reciente, 0=hace 4 semanas
      }
    });

    const semanasConDatos = semanas.filter(s => s.length >= 3);
    if (semanasConDatos.length >= 3) {
      const totales = semanas.map(s => s.reduce((a, b) => a + b, 0));
      // Comparar semana 3 (más reciente) vs semana 0 (hace 4 semanas)
      const semanaReciente = totales[3];
      const semanaAnterior = totales[2];
      const cambio = semanaReciente - semanaAnterior;
      const pctCambio = semanaAnterior > 0 ? ((cambio / semanaAnterior) * 100).toFixed(0) : 0;

      if (cambio < 0) {
        // Declinando
        const perdidaSemanal = Math.abs(cambio);
        const perdidaMensual = perdidaSemanal * 4;

        patrones.push({
          id: 'tendencia_semanal',
          icono: '📉',
          titulo: `Ventas cayeron ${pctCambio}% esta semana`,
          descripcion: `Semana pasada: $${Math.round(semanaAnterior).toLocaleString('es-AR')}. Esta semana: $${Math.round(semanaReciente).toLocaleString('es-AR')}. Caída de $${Math.round(perdidaSemanal).toLocaleString('es-AR')} en 7 días.`,
          duele: `Si sigue esta tendencia, perdés $${Math.round(perdidaMensual).toLocaleString('es-AR')} este mes`,
          recomendacion: 'Analizá qué cambió: personal, horarios, competencia nueva. Activá promociones urgentes.',
          advertencia: 'Este es un análisis preliminar. NICOLE está estudiando el comportamiento de tu negocio. Con más datos, la precisión mejora.',
          impacto_pesos: perdidaMensual,
          confianza: 70,
          detalle: {
            semana_anterior: Math.round(semanaAnterior),
            semana_reciente: Math.round(semanaReciente),
            cambio_pesos: Math.round(cambio),
            cambio_porcentual: pctCambio,
            proyeccion_mensual: Math.round(perdidaMensual),
          },
        });
      }
    }

    // ─── PATTERN E: Comparación mismo día semana pasada ────────────────────────
    const hoy = new Date();
    const estaSemana = {};
    const semanaPasada = {};

    transacciones.forEach(tx => {
      const fecha = new Date(tx.fecha);
      const diasAtras = Math.floor((ahora - fecha) / (1000 * 60 * 60 * 24));
      const dia = fecha.getDay();
      const monto = parseFloat(tx.monto);

      if (diasAtras < 7) {
        if (!estaSemana[dia]) estaSemana[dia] = 0;
        estaSemana[dia] += monto;
      } else if (diasAtras >= 7 && diasAtras < 14) {
        if (!semanaPasada[dia]) semanaPasada[dia] = 0;
        semanaPasada[dia] += monto;
      }
    });

    const DIAS_NOMBRE = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    let mayorCaida = { dia: null, caida: 0 };

    Object.keys(semanaPasada).forEach(dia => {
      if (estaSemana[dia] != null) {
        const caida = semanaPasada[dia] - estaSemana[dia];
        if (caida > mayorCaida.caida) {
          mayorCaida = { dia: parseInt(dia), caida };
        }
      }
    });

    if (mayorCaida.dia !== null && mayorCaida.caida > 500) {
      const impacto_mensual = mayorCaida.caida * 4;
      patrones.push({
        id: 'mismo_dia_caida',
        icono: '🔻',
        titulo: `${DIAS_NOMBRE[mayorCaida.dia]} cayó $${Math.round(mayorCaida.caida).toLocaleString('es-AR')} vs semana pasada`,
        descripcion: `El ${DIAS_NOMBRE[mayorCaida.dia]} de esta semana vendió $${Math.round(mayorCaida.caida).toLocaleString('es-AR')} menos que el ${DIAS_NOMBRE[mayorCaida.dia]} anterior. Algo cambió en ese día específico.`,
        duele: `Perdés $${Math.round(impacto_mensual).toLocaleString('es-AR')} al mes si esto se repite`,
        recomendacion: `Investigá qué pasó el ${DIAS_NOMBRE[mayorCaida.dia]}: faltó personal, cambió el clima, hay competencia nueva.`,
        advertencia: 'Este es un análisis preliminar. NICOLE está estudiando el comportamiento de tu negocio. Con más datos, la precisión mejora.',
        impacto_pesos: impacto_mensual,
        confianza: 65,
        detalle: {
          dia: DIAS_NOMBRE[mayorCaida.dia],
          esta_semana: Math.round(estaSemana[mayorCaida.dia]),
          semana_pasada: Math.round(semanaPasada[mayorCaida.dia]),
          caida_pesos: Math.round(mayorCaida.caida),
        },
      });
    }

    // Ordenar por impacto_pesos descendente y devolver top 3
    patrones.sort((a, b) => b.impacto_pesos - a.impacto_pesos);
    return { patrones: patrones.slice(0, 3) };

  } catch (e) {
    console.error('[WOW_MOMENT ERROR]', e);
    return { patrones: [], error: e.message };
  }
}

module.exports = { calculateWowMoment };
