// job_nocturno.js — Lumo S9
// Coordina el sistema predictivo completo. Corre a las 3AM Argentina.
// Sin cron activo — se activa cuando se upgradee Render a plan pago.
//
// Flujo:
//   1. Agregar datos del día a agregados_zona (solo publica si negocios_count >= 5)
//   2. Calcular predicciones para cada negocio activo (últimos 7 días)
//   3. Comparar predicciones de ayer con ventas reales → historial_predicciones
//      Si error > 30% por 3 días seguidos → log de alerta interna

const pool = require('./db');
const { calcularPrediccion } = require('./prediccion_adaptativa');
const { notificarUsuario } = require('./push');

// ─── Paso 1: Agregar datos del día a agregados_zona ───────────────────────────

async function agregarDatosDia(db) {
  const log = [];

  // Usuarios con transacciones hoy que tengan zona y tipo_negocio
  const usuariosRes = await db.query(`
    SELECT DISTINCT u.id, u.zona, u.tipo_negocio
    FROM usuarios u
    JOIN transacciones t ON t.usuario_id = u.id
    WHERE DATE(t.fecha) = CURRENT_DATE
      AND u.zona IS NOT NULL
      AND u.tipo_negocio IS NOT NULL
  `);

  for (const usuario of usuariosRes.rows) {
    // Métricas del día para este usuario
    const metRes = await db.query(`
      SELECT
        AVG(monto)  AS ticket_promedio,
        SUM(monto)  AS ventas_totales
      FROM transacciones
      WHERE usuario_id = $1 AND DATE(fecha) = CURRENT_DATE
    `, [usuario.id]);

    const { ticket_promedio, ventas_totales } = metRes.rows[0];
    if (!ventas_totales) continue;

    // Semana ISO (lunes de la semana actual)
    const semana = new Date();
    semana.setDate(semana.getDate() - ((semana.getDay() + 6) % 7));
    const semanaStr = semana.toISOString().slice(0, 10);

    // Upsert en agregados_zona — acumula promedio incremental
    await db.query(`
      INSERT INTO agregados_zona (zona, tipo_negocio, semana, ticket_promedio, ventas_promedio, negocios_count)
      VALUES ($1, $2, $3, $4, $5, 1)
      ON CONFLICT (zona, tipo_negocio, semana) DO UPDATE SET
        ticket_promedio = (agregados_zona.ticket_promedio * agregados_zona.negocios_count + EXCLUDED.ticket_promedio)
                          / (agregados_zona.negocios_count + 1),
        ventas_promedio = (agregados_zona.ventas_promedio * agregados_zona.negocios_count + EXCLUDED.ventas_promedio)
                          / (agregados_zona.negocios_count + 1),
        negocios_count  = agregados_zona.negocios_count + 1
    `, [usuario.zona, usuario.tipo_negocio, semanaStr, parseFloat(ticket_promedio), parseFloat(ventas_totales)]);

    log.push({ usuario_id: usuario.id, zona: usuario.zona, tipo_negocio: usuario.tipo_negocio });
  }

  // Registrar cuántas zonas tienen >= 5 negocios (W2 se activará con estos)
  const zonasActivasRes = await db.query(`
    SELECT zona, tipo_negocio, negocios_count
    FROM agregados_zona
    WHERE semana = (SELECT MAX(semana) FROM agregados_zona)
      AND negocios_count >= 5
  `);

  return {
    paso: 'agregar_datos_dia',
    usuarios_procesados: log.length,
    zonas_con_5_plus: zonasActivasRes.rows.length,
  };
}

// ─── Paso 2: Calcular predicciones para negocios activos ─────────────────────

async function calcularPredicciones(db) {
  const activosRes = await db.query(`
    SELECT DISTINCT usuario_id, sucursal_id
    FROM transacciones
    WHERE fecha >= NOW() - INTERVAL '7 days'
  `);

  const resultados = [];
  let ok = 0;
  let sin_datos = 0;
  let errores = 0;

  for (const { usuario_id, sucursal_id } of activosRes.rows) {
    try {
      const r = await calcularPrediccion(usuario_id, sucursal_id, db);
      if (r.disponible) {
        ok++;
        // Notificar al dueño por push
        await notificarUsuario(usuario_id, {
          title: 'NICOLE actualizó tus predicciones',
          body: `Horizonte ${r.horizonte} · confianza ${Math.round((r.confianza ?? 0) * 100)}%`,
          url: '/predicciones',
        }, db).catch(() => {});
      } else {
        sin_datos++;
      }
      resultados.push({ usuario_id, sucursal_id, disponible: r.disponible, horizonte: r.horizonte ?? null });
    } catch (e) {
      errores++;
      resultados.push({ usuario_id, sucursal_id, error: e.message });
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
  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = ayer.toISOString().slice(0, 10);

  // Predicciones de ayer sin valor_real aún en historial
  const pendientesRes = await db.query(`
    SELECT pn.id, pn.usuario_id, pn.sucursal_id, pn.valor_predicho
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
      WHERE usuario_id = $1
        AND ($2::integer IS NULL OR sucursal_id = $2)
        AND DATE(fecha) = $3
    `, [pred.usuario_id, pred.sucursal_id, ayerStr]);

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
        WHERE pn.usuario_id = $1
          AND hp.error_porcentual > 30
          AND hp.created_at >= NOW() - INTERVAL '3 days'
      `, [pred.usuario_id]);

      if (parseInt(rachaRes.rows[0].n) >= 3) {
        alertas.push({
          usuario_id: pred.usuario_id,
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
    SELECT p.usuario_id
    FROM productos p
    WHERE p.activo = true
    GROUP BY p.usuario_id
    HAVING (CURRENT_DATE - MAX(p.updated_at::date)) >= 15
       AND (CURRENT_DATE - MAX(p.updated_at::date)) % 15 = 0
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

// ─── Flujo principal ──────────────────────────────────────────────────────────

async function runJobNocturno(db = pool) {
  const inicio = Date.now();
  console.log('[JOB NOCTURNO] Iniciando —', new Date().toISOString());

  const pasos = [];
  try {
    pasos.push(await agregarDatosDia(db));
    pasos.push(await calcularPredicciones(db));
    pasos.push(await compararConRealidad(db));
    pasos.push(await recordatorioPreciosCatalogo(db));
  } catch (e) {
    console.error('[JOB NOCTURNO] Error fatal:', e.message);
    return { ok: false, error: e.message, pasos };
  }

  const duracion_ms = Date.now() - inicio;
  console.log(`[JOB NOCTURNO] Completado en ${duracion_ms}ms`);
  return { ok: true, duracion_ms, pasos };
}

async function triggerManual(db = pool) {
  return runJobNocturno(db);
}

module.exports = { runJobNocturno, triggerManual };

// ACTIVAR EN RENDER — descomentar cuando se upgradee a plan pago
// const cron = require('node-cron');
// cron.schedule('0 6 * * *', () => runJobNocturno(pool));
// Corre a las 6:00 UTC = 3:00 AM Argentina (UTC-3)
