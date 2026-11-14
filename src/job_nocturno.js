// job_nocturno.js — Lumo S9
// Coordina el sistema predictivo completo. Corre a las 3AM Argentina.
// Lo dispara un servicio externo (cron-job.org) con POST /api/job/trigger y el header x-internal-key.
//
// Flujo:
//   1. Agregar datos del día a agregados_zona (solo publica si negocios_count >= 5)
//   2. Calcular predicciones para cada negocio activo (últimos 7 días)
//   3. Comparar predicciones de ayer con ventas reales → historial_predicciones
//      Si error > 30% por 3 días seguidos → log de alerta interna

const pool = require('./db');
const { calcularPrediccion, ownerDeNegocio } = require('./prediccion_adaptativa');
const { guardarClimaReciente } = require('./clima_diario');
const { notificarUsuario } = require('./push');
const { calcularRiesgoAjustado } = require('./erm');
const { detectarGoteo } = require('./cruce_variables');

// ─── Paso 1: Agregados de la semana por zona y rubro (efecto red) ───────────
// Se recalcula la semana completa desde cero en cada corrida: negocios_count = negocios DISTINTOS.
// Antes se sumaba +1 por corrida, así que un solo negocio llegaba a "5 negocios" en 5 noches y se
// rompía el mínimo de 5 (privacidad). Además buscaba ventas por usuario_id, que la caja no carga.

async function agregarDatosDia(db) {
  const r = await db.query(`
    WITH semana AS (
      SELECT (date_trunc('week', NOW() - INTERVAL '3 hours'))::date AS lunes
    ),
    por_negocio AS (
      SELECT n.id, n.zona, n.tipo_negocio,
             AVG(t.monto) AS ticket,
             SUM(t.monto) / NULLIF(COUNT(DISTINCT (t.fecha - INTERVAL '3 hours')::date), 0) AS venta_dia
      FROM negocios n
      JOIN transacciones t ON t.negocio_id = n.id
      CROSS JOIN semana s
      WHERE n.zona IS NOT NULL AND n.tipo_negocio IS NOT NULL AND n.deletion_scheduled_at IS NULL
        AND (t.fecha - INTERVAL '3 hours')::date >= s.lunes
      GROUP BY n.id, n.zona, n.tipo_negocio
    )
    INSERT INTO agregados_zona (zona, tipo_negocio, semana, ticket_promedio, ventas_promedio, negocios_count)
    SELECT zona, tipo_negocio, (SELECT lunes FROM semana), AVG(ticket), AVG(venta_dia), COUNT(*)
    FROM por_negocio
    GROUP BY zona, tipo_negocio
    ON CONFLICT (zona, tipo_negocio, semana) DO UPDATE SET
      ticket_promedio = EXCLUDED.ticket_promedio,
      ventas_promedio = EXCLUDED.ventas_promedio,
      negocios_count  = EXCLUDED.negocios_count
    RETURNING zona, tipo_negocio, negocios_count
  `);

  return {
    paso: 'agregar_datos_dia',
    grupos_zona_rubro: r.rows.length,
    zonas_con_5_plus: r.rows.filter(x => x.negocios_count >= 5).length,
  };
}

// ─── Paso 2: Calcular predicciones para negocios activos ─────────────────────

async function calcularPredicciones(db) {
  const activosRes = await db.query(`
    SELECT DISTINCT negocio_id, sucursal_id
    FROM transacciones
    WHERE fecha >= NOW() - INTERVAL '7 days' AND negocio_id IS NOT NULL
  `);

  const resultados = [];
  let ok = 0;
  let sin_datos = 0;
  let errores = 0;

  for (const { negocio_id, sucursal_id } of activosRes.rows) {
    try {
      const r = await calcularPrediccion(negocio_id, sucursal_id, db);
      if (r.disponible) {
        ok++;
        // Notificar al dueño por push
        const ownerId = await ownerDeNegocio(negocio_id, db);
        if (ownerId) await notificarUsuario(ownerId, {
          title: 'NICOLE actualizó tus predicciones',
          body: `Horizonte ${r.horizonte} · confianza ${Math.round((r.confianza ?? 0) * 100)}%`,
          url: '/predicciones',
        }, db).catch(() => {});
      } else {
        sin_datos++;
      }
      resultados.push({ negocio_id, sucursal_id, disponible: r.disponible, horizonte: r.horizonte ?? null });
    } catch (e) {
      errores++;
      resultados.push({ negocio_id, sucursal_id, error: e.message });
    }
  }

  return {
    paso: 'calcular_predicciones',
    total: activosRes.rows.length,
    ok,
    sin_datos,
    errores,
  };
}

// ─── Paso 3: Comparar predicciones de ayer con realidad ──────────────────────

async function compararConRealidad(db) {
  // "Ayer" en hora Argentina
  const ayerStr = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);

  // Predicciones de ayer sin valor_real aún en historial
  const pendientesRes = await db.query(`
    SELECT pn.id, pn.negocio_id, pn.sucursal_id, pn.valor_predicho
    FROM predicciones_negocio pn
    LEFT JOIN historial_predicciones hp ON hp.prediccion_id = pn.id
    WHERE pn.fecha_target = $1 AND hp.id IS NULL
  `, [ayerStr]);

  const alertas = [];
  let comparadas = 0;

  for (const pred of pendientesRes.rows) {
    // Ventas reales de esa fecha
    const realRes = await db.query(`
      SELECT COALESCE(SUM(monto), 0) AS total
      FROM transacciones
      WHERE negocio_id = $1
        AND ($2::integer IS NULL OR sucursal_id = $2)
        AND (fecha - INTERVAL '3 hours')::date = $3::date
    `, [pred.negocio_id, pred.sucursal_id, ayerStr]);

    const valor_real = parseFloat(realRes.rows[0].total);
    const error_absoluto = Math.abs(valor_real - parseFloat(pred.valor_predicho));
    const error_porcentual = pred.valor_predicho > 0
      ? Math.round((error_absoluto / parseFloat(pred.valor_predicho)) * 10000) / 100
      : null;

    await db.query(`
      INSERT INTO historial_predicciones
        (prediccion_id, valor_real, error_absoluto, error_porcentual, aprendizaje_aplicado)
      VALUES ($1, $2, $3, $4, false)
    `, [pred.id, valor_real, Math.round(error_absoluto * 100) / 100, error_porcentual]);

    comparadas++;

    // Revisar si hay 3 días seguidos con error > 30%
    if (error_porcentual !== null && error_porcentual > 30) {
      const rachaRes = await db.query(`
        SELECT COUNT(*) AS n
        FROM historial_predicciones hp
        JOIN predicciones_negocio pn ON pn.id = hp.prediccion_id
        WHERE pn.negocio_id = $1
          AND pn.sucursal_id IS NOT DISTINCT FROM $2::integer
          AND hp.error_porcentual > 30
          AND hp.created_at >= NOW() - INTERVAL '3 days'
      `, [pred.negocio_id, pred.sucursal_id]);

      if (parseInt(rachaRes.rows[0].n) >= 3) {
        alertas.push({
          negocio_id: pred.negocio_id,
          sucursal_id: pred.sucursal_id,
          mensaje: `Error de predicción > 30% por 3 días consecutivos. Revisar calidad de señal propia.`,
        });
        console.warn('[JOB NOCTURNO] Alerta predicción:', alertas[alertas.length - 1]);
      }
    }
  }

  return {
    paso: 'comparar_realidad',
    predicciones_comparadas: comparadas,
    alertas_internas: alertas.length,
    alertas,
  };
}

// ─── Paso 4: Recordatorio amigable si el catálogo lleva 15 días sin actualizarse ─
// Lógica: CURRENT_DATE - MAX(updated_at) es múltiplo de 15 → envía push una vez
// por ciclo de 15 días de inactividad (sin almacenar estado extra).

async function recordatorioPreciosCatalogo(db) {
  const usuariosRes = await db.query(`
    SELECT nu.usuario_id
    FROM productos p
    JOIN negocio_usuarios nu ON nu.negocio_id = p.negocio_id AND nu.rol = 'owner' AND nu.activo = true
    WHERE p.activo = true
    GROUP BY p.negocio_id, nu.usuario_id
    HAVING ((NOW() - INTERVAL '3 hours')::date - MAX((p.updated_at - INTERVAL '3 hours')::date)) >= 15
       AND ((NOW() - INTERVAL '3 hours')::date - MAX((p.updated_at - INTERVAL '3 hours')::date)) % 15 = 0
  `);

  let enviados = 0;
  for (const { usuario_id } of usuariosRes.rows) {
    await notificarUsuario(usuario_id, {
      title: '¿Actualizaste tus precios?',
      body: 'Mantené el catálogo al día para que NICOLE pueda ayudarte mejor.',
      url: '/catalogo',
    }, db).catch(() => {});
    enviados++;
  }

  return { paso: 'recordatorio_precios_catalogo', enviados };
}

// ─── Paso 5: Snapshots ERM diarios + notificaciones de riesgo ─────────────────

async function snapshotsERM(db) {
  // Fechas en hora Argentina
  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const ayerStr = new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);

  // Todos los negocios activos
  const negociosRes = await db.query(`
    SELECT id FROM negocios WHERE deletion_scheduled_at IS NULL
  `);

  let snapshotsCreados = 0;
  let notificacionesEnviadas = 0;

  for (const { id: negocio_id } of negociosRes.rows) {
    // Empleados distintos con turnos en los últimos 30 días para este negocio
    const empleadosRes = await db.query(`
      SELECT DISTINCT nombre_empleado
      FROM turnos_caja
      WHERE negocio_id=$1 AND estado='cerrado'
        AND hora_apertura >= NOW() - INTERVAL '30 days'
    `, [negocio_id]);

    for (const { nombre_empleado } of empleadosRes.rows) {
      try {
        const resultado = await calcularRiesgoAjustado(negocio_id, nombre_empleado);

        if (resultado.ajustado === null) continue;

        // Buscar snapshot de ayer
        const ayerRes = await db.query(`
          SELECT nivel FROM erm_historico
          WHERE negocio_id=$1 AND empleado=$2 AND fecha=$3
        `, [negocio_id, nombre_empleado, ayerStr]);

        const nivelAyer = ayerRes.rows.length > 0 ? ayerRes.rows[0].nivel : null;

        // Insertar/actualizar snapshot de hoy
        await db.query(`
          INSERT INTO erm_historico(
            negocio_id, sucursal_id, empleado, fecha,
            risk_score_bruto, factor_aplicado, risk_score_ajustado,
            nivel, senales, turnos_analizados
          ) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (negocio_id, empleado, fecha)
          DO UPDATE SET
            risk_score_bruto=$4, factor_aplicado=$5, risk_score_ajustado=$6,
            nivel=$7, senales=$8, turnos_analizados=$9
        `, [
          negocio_id,
          nombre_empleado,
          hoy,
          resultado.bruto.score,
          resultado.factor,
          resultado.ajustado,
          resultado.nivel,
          JSON.stringify(resultado.señales),
          resultado.bruto.detalle?.n_turnos || 0
        ]);

        snapshotsCreados++;

        // Notificación: si ayer NO era rojo y hoy SÍ es rojo
        if (nivelAyer !== 'rojo' && resultado.nivel === 'rojo') {
          // Buscar usuario_id del negocio (owner o primer socio activo)
          const usuarioRes = await db.query(`
            SELECT usuario_id FROM negocio_usuarios
            WHERE negocio_id=$1 AND activo=true
            ORDER BY created_at ASC LIMIT 1
          `, [negocio_id]);

          if (usuarioRes.rows.length > 0) {
            const usuario_id = usuarioRes.rows[0].usuario_id;
            await notificarUsuario(usuario_id, {
              title: 'Patrón de riesgo detectado',
              body: 'Un empleado mostró señales de riesgo elevado en los últimos turnos. Revisá el detalle en la pantalla de empleados.',
              url: '/empleados',
            }, db).catch(() => {});
            notificacionesEnviadas++;
          }
        }
      } catch (e) {
        console.error(`[SNAPSHOT ERM] Error con ${nombre_empleado} (negocio ${negocio_id}):`, e.message);
      }
    }
  }

  return {
    paso: 'snapshots_erm',
    snapshots_creados: snapshotsCreados,
    notificaciones_enviadas: notificacionesEnviadas,
  };
}

// ─── Paso 6: Snapshots Goteo diarios + notificaciones ────────────────────────

async function snapshotsGoteo(db) {
  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  const negociosRes = await db.query(`
    SELECT id FROM negocios WHERE deletion_scheduled_at IS NULL
  `);

  let goteosDetectados = 0;
  let notificacionesEnviadas = 0;

  for (const { id: negocio_id } of negociosRes.rows) {
    try {
      const resultado = await detectarGoteo(negocio_id, 21);

      // Caso de datos insuficientes: guardar registro simple, no notificar
      if (resultado.motivo === 'datos_insuficientes') {
        await db.query(`
          INSERT INTO goteo_historico(negocio_id, fecha, detectado, motivo)
          VALUES($1,$2,false,$3)
          ON CONFLICT (negocio_id, fecha) DO UPDATE SET detectado=false, motivo=$3
        `, [negocio_id, hoy, resultado.motivo]);
        continue;
      }

      await db.query(`
        INSERT INTO goteo_historico(
          negocio_id, fecha, detectado, ventana_dias,
          turnos_analizados, turnos_con_brecha, porcentaje_con_brecha,
          brecha_total_acumulada, brecha_promedio_por_turno,
          patron_empleado, patron_turno, mensaje
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (negocio_id, fecha)
        DO UPDATE SET
          detectado=$3, ventana_dias=$4, turnos_analizados=$5,
          turnos_con_brecha=$6, porcentaje_con_brecha=$7,
          brecha_total_acumulada=$8, brecha_promedio_por_turno=$9,
          patron_empleado=$10, patron_turno=$11, mensaje=$12
      `, [
        negocio_id, hoy, resultado.detectado, resultado.ventana_dias,
        resultado.turnos_analizados, resultado.turnos_con_brecha,
        resultado.porcentaje_con_brecha, resultado.brecha_total_acumulada,
        resultado.brecha_promedio_por_turno,
        resultado.patron_empleado ? JSON.stringify(resultado.patron_empleado) : null,
        resultado.patron_turno ? JSON.stringify(resultado.patron_turno) : null,
        resultado.mensaje
      ]);

      if (resultado.detectado) {
        goteosDetectados++;

        const usuarioRes = await db.query(`
          SELECT usuario_id FROM negocio_usuarios
          WHERE negocio_id=$1 AND activo=true
          ORDER BY created_at ASC LIMIT 1
        `, [negocio_id]);

        if (usuarioRes.rows.length > 0) {
          const usuario_id = usuarioRes.rows[0].usuario_id;
          await notificarUsuario(usuario_id, {
            title: 'Diferencias pequeñas y repetidas',
            body: resultado.mensaje,
            url: '/empleados',
          }, db).catch(() => {});
          notificacionesEnviadas++;
        }
      }
    } catch (e) {
      console.error(`[SNAPSHOT GOTEO] Error con negocio ${negocio_id}:`, e.message);
    }
  }

  return {
    paso: 'snapshots_goteo',
    goteos_detectados: goteosDetectados,
    notificaciones_enviadas: notificacionesEnviadas,
  };
}

// ─── Flujo principal ──────────────────────────────────────────────────────────

async function runJobNocturno(db = pool) {
  const inicio = Date.now();
  console.log('[JOB NOCTURNO] Iniciando —', new Date().toISOString());

  // Cada paso corre aunque otro falle: antes un error en el paso 1 cortaba predicciones, ERM y goteo.
  const pasos = [];
  const PASOS = [
    ['agregar_datos_dia', agregarDatosDia],
    ['clima', guardarClimaReciente],
    ['calcular_predicciones', calcularPredicciones],
    ['comparar_realidad', compararConRealidad],
    ['recordatorio_precios_catalogo', recordatorioPreciosCatalogo],
    ['snapshots_erm', snapshotsERM],
    ['snapshots_goteo', snapshotsGoteo],
  ];
  let fallidos = 0;
  for (const [nombre, fn] of PASOS) {
    try {
      pasos.push(await fn(db));
    } catch (e) {
      fallidos++;
      console.error(`[JOB NOCTURNO] Paso ${nombre} fallo:`, e.message);
      pasos.push({ paso: nombre, error: e.message });
    }
  }

  const duracion_ms = Date.now() - inicio;
  console.log(`[JOB NOCTURNO] Completado en ${duracion_ms}ms`);
  return { ok: fallidos === 0, pasos_fallidos: fallidos, duracion_ms, pasos };
}

async function triggerManual(db = pool) {
  return runJobNocturno(db);
}

module.exports = { runJobNocturno, triggerManual };

// ACTIVAR EN RENDER — descomentar cuando se upgradee a plan pago
// const cron = require('node-cron');
// cron.schedule('0 6 * * *', () => runJobNocturno(pool));
// Corre a las 6:00 UTC = 3:00 AM Argentina (UTC-3)
