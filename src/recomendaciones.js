// recomendaciones.js — Lumo S7
// Objetivo 6: Motor de recomendaciones de gestión
//
// Genera recomendaciones concretas para el dueño basadas en patrones detectados.
// REGLAS:
//   - Nunca nombrar empleados en recomendaciones automáticas (sí en pantalla Equipo)
//   - Cada recomendación termina con acción concreta
//   - Prioridad: critico > atencion > positivo
//   - La predicción siempre dispara una acción concreta

const pool = require('./db');

// ─── Reglas de recomendación ──────────────────────────────────────────────────

const REGLAS = [

  // R1: Turno con inconsistencias sostenidas (3+ semanas)
  {
    id: 'TURNO_INCONSISTENTE_SOSTENIDO',
    categoria: 'inconsistencia_operativa',
    prioridad: 'critica',
    evaluar: async (usuarioId) => {
      const res = await pool.query(
        `SELECT tipo_turno,
                COUNT(*) FILTER (WHERE ABS(brecha) > 1000) as turnos_con_brecha,
                COUNT(*) as total_turnos,
                MIN(hora_apertura) as primer_turno
         FROM turnos_caja
         WHERE usuario_id=$1 AND estado='cerrado'
           AND hora_apertura >= NOW() - INTERVAL '21 days'
         GROUP BY tipo_turno
         HAVING COUNT(*) >= 6`,
        [usuarioId]
      );
      const alertas = [];
      for (const r of res.rows) {
        const tasa = parseInt(r.turnos_con_brecha) / parseInt(r.total_turnos);
        if (tasa >= 0.5) {
          alertas.push({
            turno: r.tipo_turno,
            tasa: Math.round(tasa * 100),
            semanas: 3,
          });
        }
      }
      return alertas;
    },
    mensaje: ({ turno, tasa }) =>
      `El turno ${turno} acumula inconsistencias en el ${tasa}% de los turnos las últimas 3 semanas.`,
    accion: ({ turno }) =>
      `Considerá supervisión presencial en el turno ${turno} esta semana. Si el patrón continúa, es momento de hablar con el equipo.`,
  },

  // R2: Brecha creciente semana tras semana
  {
    id: 'BRECHA_CRECIENTE',
    categoria: 'tendencia_negativa',
    prioridad: 'alta',
    evaluar: async (usuarioId) => {
      const res = await pool.query(
        `SELECT
           DATE_TRUNC('week', hora_apertura) as semana,
           AVG(ABS(brecha)) as brecha_promedio
         FROM turnos_caja
         WHERE usuario_id=$1 AND estado='cerrado' AND brecha IS NOT NULL
           AND hora_apertura >= NOW() - INTERVAL '28 days'
         GROUP BY semana
         ORDER BY semana ASC`,
        [usuarioId]
      );
      if (res.rows.length < 3) return [];
      const brechas = res.rows.map(r => parseFloat(r.brecha_promedio));
      // Verificar tendencia creciente: cada semana > anterior
      let creciente = true;
      for (let i = 1; i < brechas.length; i++) {
        if (brechas[i] <= brechas[i - 1]) { creciente = false; break; }
      }
      if (!creciente) return [];
      const crecimiento = Math.round(((brechas[brechas.length - 1] / brechas[0]) - 1) * 100);
      return [{ semanas: brechas.length, crecimiento, brecha_actual: Math.round(brechas[brechas.length - 1]) }];
    },
    mensaje: ({ crecimiento, brecha_actual }) =>
      `La brecha de caja creció ${crecimiento}% en las últimas semanas. Brecha promedio actual: $${brecha_actual.toLocaleString('es-AR')}.`,
    accion: () =>
      `Momento de reunirse con el equipo y revisar el proceso de cierre. La tendencia sostenida requiere intervención.`,
  },

  // R3: Alto porcentaje de conteos omitidos
  {
    id: 'CONTEOS_OMITIDOS_FRECUENTES',
    categoria: 'error_operativo',
    prioridad: 'alta',
    evaluar: async (usuarioId) => {
      const res = await pool.query(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN conteo_aleatorio_omitido THEN 1 ELSE 0 END) as omitidos,
           tipo_turno
         FROM turnos_caja
         WHERE usuario_id=$1 AND estado='cerrado'
           AND hora_apertura >= NOW() - INTERVAL '21 days'
         GROUP BY tipo_turno
         HAVING COUNT(*) >= 4`,
        [usuarioId]
      );
      const alertas = [];
      for (const r of res.rows) {
        const tasa = parseInt(r.omitidos) / parseInt(r.total);
        if (tasa >= 0.30) {
          alertas.push({ turno: r.tipo_turno, tasa: Math.round(tasa * 100), omitidos: parseInt(r.omitidos) });
        }
      }
      return alertas;
    },
    mensaje: ({ tasa, turno }) =>
      `${tasa}% de los conteos aleatorios en el turno ${turno} no fueron respondidos.`,
    accion: ({ turno }) =>
      `Reforzar con el equipo del turno ${turno} la importancia del conteo a tiempo. Si persiste, revisá si el tiempo de respuesta es suficiente.`,
  },

  // R4: Turno sin inconsistencias en 7+ días (mensaje positivo)
  {
    id: 'RACHA_POSITIVA_TURNO',
    categoria: 'positivo',
    prioridad: 'info',
    evaluar: async (usuarioId) => {
      const res = await pool.query(
        `SELECT tipo_turno, COUNT(*) as n_limpios
         FROM turnos_caja
         WHERE usuario_id=$1 AND estado='cerrado'
           AND ABS(COALESCE(brecha,0)) <= 1000
           AND conteo_aleatorio_omitido = false
           AND hora_apertura >= NOW() - INTERVAL '14 days'
         GROUP BY tipo_turno
         HAVING COUNT(*) >= 7`,
        [usuarioId]
      );
      return res.rows.map(r => ({ turno: r.tipo_turno, n: parseInt(r.n_limpios) }));
    },
    mensaje: ({ turno, n }) =>
      `El turno ${turno} lleva ${n} turnos consecutivos sin inconsistencias.`,
    accion: ({ turno }) =>
      `Buen momento para reconocer el trabajo del turno ${turno}. La consistencia sostenida es el mejor indicador de proceso sano.`,
  },

  // R5: Diferencia notable de brecha entre tipos de turno
  {
    id: 'DIFERENCIA_ENTRE_TURNOS',
    categoria: 'atencion',
    prioridad: 'media',
    evaluar: async (usuarioId) => {
      const res = await pool.query(
        `SELECT tipo_turno, AVG(ABS(brecha)) as brecha_media, COUNT(*) as n
         FROM turnos_caja
         WHERE usuario_id=$1 AND estado='cerrado' AND brecha IS NOT NULL
           AND hora_apertura >= NOW() - INTERVAL '30 days'
         GROUP BY tipo_turno
         HAVING COUNT(*) >= 5`,
        [usuarioId]
      );
      if (res.rows.length < 2) return [];
      const turnos = res.rows.map(r => ({ turno: r.tipo_turno, brecha: parseFloat(r.brecha_media), n: parseInt(r.n) }));
      turnos.sort((a, b) => b.brecha - a.brecha);
      const ratio = turnos[0].brecha / (turnos[turnos.length - 1].brecha || 1);
      if (ratio < 2.5) return [];
      return [{
        turno_mayor: turnos[0].turno,
        turno_menor: turnos[turnos.length - 1].turno,
        brecha_mayor: Math.round(turnos[0].brecha),
        ratio: Math.round(ratio * 10) / 10,
      }];
    },
    mensaje: ({ turno_mayor, brecha_mayor, ratio }) =>
      `El turno ${turno_mayor} tiene ${ratio}x más brecha promedio que el mejor turno. Brecha promedio: $${brecha_mayor.toLocaleString('es-AR')}.`,
    accion: ({ turno_mayor }) =>
      `Revisá qué está pasando en el turno ${turno_mayor}. Compará los procesos con el turno de mejor desempeño.`,
  },

  // R6: Egresos sin patrón claro (muchos egresos, bajo monto promedio)
  {
    id: 'EGRESOS_FRAGMENTADOS',
    categoria: 'atencion',
    prioridad: 'media',
    evaluar: async (usuarioId) => {
      const res = await pool.query(
        `SELECT COUNT(*) as total_egresos, AVG(monto) as monto_promedio
         FROM egresos_caja
         WHERE usuario_id=$1 AND hora >= NOW() - INTERVAL '7 days'`,
        [usuarioId]
      );
      const total = parseInt(res.rows[0]?.total_egresos || 0);
      const promedio = parseFloat(res.rows[0]?.monto_promedio || 0);
      if (total < 10 || promedio > 2000) return [];
      return [{ total, monto_promedio: Math.round(promedio) }];
    },
    mensaje: ({ total, monto_promedio }) =>
      `${total} egresos esta semana con promedio de $${monto_promedio.toLocaleString('es-AR')} cada uno — patrón inusual.`,
    accion: () =>
      `Revisá el listado de egresos de esta semana. Muchos egresos de bajo monto pueden indicar retiros no autorizados fragmentados.`,
  },

];

// ─── Generador principal ──────────────────────────────────────────────────────

async function generarRecomendaciones(usuarioId) {
  const resultados = [];

  await Promise.allSettled(
    REGLAS.map(async (regla) => {
      try {
        const casos = await regla.evaluar(usuarioId);
        for (const caso of casos) {
          resultados.push({
            id: regla.id,
            categoria: regla.categoria,
            prioridad: regla.prioridad,
            mensaje: regla.mensaje(caso),
            accion: regla.accion(caso),
            datos: caso,
          });
        }
      } catch (e) {
        // Regla falla silenciosamente — no rompemos el resto
        console.error(`Regla ${regla.id} falló:`, e.message);
      }
    })
  );

  // Ordenar por prioridad
  const orden = { critica: 0, alta: 1, media: 2, info: 3 };
  resultados.sort((a, b) => (orden[a.prioridad] ?? 4) - (orden[b.prioridad] ?? 4));

  const criticas = resultados.filter(r => r.prioridad === 'critica');
  const altas = resultados.filter(r => r.prioridad === 'alta');
  const medias = resultados.filter(r => r.prioridad === 'media');
  const info = resultados.filter(r => r.prioridad === 'info');

  return {
    total: resultados.length,
    criticas: criticas.length,
    altas: altas.length,
    medias: medias.length,
    positivas: info.length,
    recomendaciones: resultados,
    resumen_accion: criticas.length > 0
      ? criticas[0].accion
      : altas.length > 0
        ? altas[0].accion
        : info.length > 0
          ? info[0].mensaje
          : 'Todo dentro del rango esperado. Mantener el seguimiento habitual.',
  };
}

module.exports = { generarRecomendaciones };
