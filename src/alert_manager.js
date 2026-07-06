// alert_manager.js — Lumo S7
// Objetivo 7: Alert manager con cap diario
//
// Reglas:
//   - Máximo 2 intervenciones fuertes por turno (critico/inconsistencia)
//   - Máximo 5 alertas totales por día
//   - Balance 70% positivo+info / 20% atención / 10% crítico
//   - Deduplicación: no emitir la misma alerta dos veces en 24h
//   - Z-score >4.0 → excepción: alerta solo aunque no haya 2 señales
//   - Feedback loop: cada alerta tiene campo para confirmar/descartar

const pool = require('./db');

// ─── Prioridades y categorías ─────────────────────────────────────────────────

const PESO = {
  critico:               0,
  inconsistencia:        1,
  atencion:              2,
  ineficiencia:          3,
  error_operativo:       4,
  positivo:              5,
  info:                  6,
};

// ─── Deduplicación ────────────────────────────────────────────────────────────
// Clave única: usuario + tipo_alerta + contexto
// Si la misma alerta ya se emitió en las últimas 24h → suprimir

async function yaEmitidaHoy(negocioId, tipoAlerta, contexto = '') {
  const res = await pool.query(
    `SELECT id FROM alertas_gestionadas
     WHERE negocio_id=$1 AND tipo_alerta=$2 AND contexto=$3
       AND created_at >= NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [negocioId, tipoAlerta, contexto]
  );
  return res.rows.length > 0;
}

async function registrarAlerta(negocioId, alerta) {
  await pool.query(
    `INSERT INTO alertas_gestionadas(negocio_id, tipo_alerta, contexto, prioridad, mensaje, accion, datos)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [
      negocioId,
      alerta.tipo,
      alerta.contexto || '',
      alerta.prioridad,
      alerta.mensaje || '',
      alerta.accion || '',
      JSON.stringify(alerta.datos || {}),
    ]
  );
}

// ─── Cap diario ───────────────────────────────────────────────────────────────

async function cantidadAlertasHoy(negocioId) {
  const res = await pool.query(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE prioridad IN ('critico','inconsistencia')) as fuertes
     FROM alertas_gestionadas
     WHERE negocio_id=$1 AND created_at >= NOW() - INTERVAL '24 hours'`,
    [negocioId]
  );
  return {
    total: parseInt(res.rows[0].total),
    fuertes: parseInt(res.rows[0].fuertes),
  };
}

// ─── Pipeline principal ───────────────────────────────────────────────────────
// Toma todas las alertas candidatas de todos los motores,
// aplica filtros y devuelve las que deben mostrarse.

async function gestionarAlertas(negocioId, alertasCandidatas) {
  if (!alertasCandidatas || alertasCandidatas.length === 0) return { alertas: [], suprimidas: 0 };

  const caps = await cantidadAlertasHoy(negocioId);
  const CAP_FUERTES = 2;
  const CAP_TOTAL   = 5;

  let fuertesEmitidas = caps.fuertes;
  let totalEmitidas   = caps.total;
  const alertasFiltradas = [];
  const suprimidas = [];

  // Ordenar por prioridad (menor = más urgente)
  const candidatas = [...alertasCandidatas].sort((a, b) => (PESO[a.prioridad] ?? 9) - (PESO[b.prioridad] ?? 9));

  for (const alerta of candidatas) {
    const esFuerte = ['critico', 'inconsistencia'].includes(alerta.prioridad);
    const contexto = alerta.contexto || alerta.turno || '';

    // Excepción Z-score >4: pasa igual aunque supere el cap
    const esExcepcion = alerta.zscore && Math.abs(alerta.zscore) >= 4.0;

    // Cap de fuertes
    if (esFuerte && !esExcepcion && fuertesEmitidas >= CAP_FUERTES) {
      suprimidas.push({ ...alerta, motivo_supresion: 'cap_fuertes_alcanzado' });
      continue;
    }

    // Cap total
    if (!esExcepcion && totalEmitidas >= CAP_TOTAL) {
      suprimidas.push({ ...alerta, motivo_supresion: 'cap_total_alcanzado' });
      continue;
    }

    // Deduplicación
    const duplicada = await yaEmitidaHoy(negocioId, alerta.tipo, contexto).catch(() => false);
    if (duplicada && !esExcepcion) {
      suprimidas.push({ ...alerta, motivo_supresion: 'duplicada_24h' });
      continue;
    }

    // Agregar a la lista final
    alertasFiltradas.push({
      ...alerta,
      id_interno: `${alerta.tipo}_${contexto}_${Date.now()}`,
      timestamp: new Date().toISOString(),
      feedback: { confirmada: null, descartada: false },
    });

    // Registrar en DB para control de caps
    await registrarAlerta(negocioId, { ...alerta, contexto }).catch(() => {});

    if (esFuerte) fuertesEmitidas++;
    totalEmitidas++;
  }

  // Balance final: asegurar al menos 1 positivo si hay alertas críticas
  const tieneCriticas = alertasFiltradas.some(a => a.prioridad === 'critico');
  const tienePositivos = alertasFiltradas.some(a => ['positivo', 'info'].includes(a.prioridad));
  if (tieneCriticas && !tienePositivos) {
    // Buscar un positivo de las suprimidas para incluirlo
    const positivoSuprimido = suprimidas.find(a => ['positivo', 'info'].includes(a.prioridad));
    if (positivoSuprimido) {
      alertasFiltradas.push({ ...positivoSuprimido, id_interno: `${positivoSuprimido.tipo}_balance`, timestamp: new Date().toISOString() });
    }
  }

  // Stats de balance para el dueño
  const criticos  = alertasFiltradas.filter(a => ['critico','inconsistencia'].includes(a.prioridad)).length;
  const atencion  = alertasFiltradas.filter(a => ['atencion','ineficiencia'].includes(a.prioridad)).length;
  const positivos = alertasFiltradas.filter(a => ['positivo','info'].includes(a.prioridad)).length;
  const total     = alertasFiltradas.length;

  return {
    alertas: alertasFiltradas,
    suprimidas: suprimidas.length,
    stats: {
      total,
      criticos,
      atencion,
      positivos,
      balance_pct: total > 0 ? {
        critico: Math.round((criticos / total) * 100),
        atencion: Math.round((atencion / total) * 100),
        positivo: Math.round((positivos / total) * 100),
      } : null,
      caps: { fuertes_usadas: fuertesEmitidas, fuertes_max: CAP_FUERTES, total_usadas: totalEmitidas, total_max: CAP_TOTAL },
    },
  };
}

// ─── Feedback loop ────────────────────────────────────────────────────────────
// El dueño confirma o descarta una alerta → se registra para P7 (EWTA)

async function registrarFeedback(alertaId, feedback) {
  // feedback: { confirmada: bool, notas: string }
  await pool.query(
    `UPDATE alertas_gestionadas
     SET feedback_confirmada=$1, feedback_notas=$2, feedback_at=NOW()
     WHERE id=$3`,
    [feedback.confirmada, feedback.notas || null, alertaId]
  );
  return { ok: true };
}

// ─── Tabla de alertas gestionadas (para setup.js) ────────────────────────────
// Esta función crea la tabla. Llamar desde setup.js.

async function crearTablaAlertas(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS alertas_gestionadas(
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER REFERENCES usuarios(id),
    tipo_alerta VARCHAR(100) NOT NULL,
    contexto VARCHAR(200) DEFAULT '',
    prioridad VARCHAR(30),
    mensaje TEXT,
    accion TEXT,
    datos JSONB DEFAULT '{}',
    feedback_confirmada BOOLEAN,
    feedback_notas TEXT,
    feedback_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
}

module.exports = { gestionarAlertas, registrarFeedback, crearTablaAlertas };
