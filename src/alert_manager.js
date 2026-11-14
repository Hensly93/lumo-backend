// alert_manager.js — LumoBi
// Toma las señales de todos los motores y arma la lista de alertas que ve el dueño.
//
// Reglas (actualizado 13/11/2026):
//   - Sin tope diario de alertas (decisión del 11/11): todo lo que el motor detecta se muestra.
//   - Una alerta detectada se REGISTRA una sola vez cada 24 h (tipo + contexto) y se sigue MOSTRANDO
//     en todas las pantallas mientras el motor la siga detectando. Antes, la segunda carga la
//     tomaba como "duplicada" y desaparecía del Home y de Alertas.
//   - Si el dueño la descartó (falso positivo), no se vuelve a mostrar en esas 24 h.
//   - Cada alerta lleva el id real de la base (alerta_id) para el feedback correcta / falso positivo.
//   - Balance: si hay críticas y ninguna positiva, se suma una positiva si existe.

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

// La alerta (tipo + contexto) ya registrada en las últimas 24 h, o null
async function alertaReciente(negocioId, tipoAlerta, contexto = '') {
  const res = await pool.query(
    `SELECT id, feedback_confirmada, created_at FROM alertas_gestionadas
     WHERE negocio_id=$1 AND tipo_alerta=$2 AND contexto=$3
       AND created_at >= NOW() - INTERVAL '24 hours'
     ORDER BY id DESC LIMIT 1`,
    [negocioId, tipoAlerta, contexto]
  );
  return res.rows[0] || null;
}

async function registrarAlerta(negocioId, alerta) {
  const r = await pool.query(
    `INSERT INTO alertas_gestionadas(negocio_id, tipo_alerta, contexto, prioridad, mensaje, accion, datos)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, created_at`,
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
  return r.rows[0];
}

// ─── Pipeline principal ───────────────────────────────────────────────────────
// Toma todas las alertas candidatas de todos los motores y devuelve las que se muestran.
// Se puede llamar en cada carga de pantalla: no "gasta" las alertas.

async function gestionarAlertas(negocioId, alertasCandidatas) {
  if (!alertasCandidatas || alertasCandidatas.length === 0) return { alertas: [], suprimidas: 0, stats: statsDe([]) };

  const alertasFiltradas = [];
  const suprimidas = [];
  const vistas = new Set();

  // Ordenar por prioridad (menor = más urgente)
  const candidatas = [...alertasCandidatas].sort((a, b) => (PESO[a.prioridad] ?? 9) - (PESO[b.prioridad] ?? 9));

  for (const alerta of candidatas) {
    const contexto = String(alerta.contexto || alerta.turno || '');
    const clave = alerta.tipo + '|' + contexto;
    if (vistas.has(clave)) { suprimidas.push({ ...alerta, motivo_supresion: 'repetida_en_la_lista' }); continue; }
    vistas.add(clave);

    let fila = null;
    try {
      fila = await alertaReciente(negocioId, alerta.tipo, contexto);
      if (fila && fila.feedback_confirmada === false) {
        suprimidas.push({ ...alerta, motivo_supresion: 'descartada_por_el_dueno' });
        continue;
      }
      if (!fila) fila = await registrarAlerta(negocioId, { ...alerta, contexto });
    } catch (e) {
      console.error('[alertas] registro:', e.message);
    }

    const id = fila ? fila.id : null;
    alertasFiltradas.push({
      ...alerta,
      contexto,
      alerta_id: id,
      // el frontend usa id_interno como clave y lo manda como alerta_id en el feedback
      id_interno: id != null ? String(id) : `${alerta.tipo}_${contexto}`,
      timestamp: fila && fila.created_at ? new Date(fila.created_at).toISOString() : new Date().toISOString(),
      feedback: { confirmada: fila && fila.feedback_confirmada === true ? true : null, descartada: false },
    });
  }

  // Balance final: asegurar al menos 1 positivo si hay alertas críticas
  const tieneCriticas = alertasFiltradas.some(a => a.prioridad === 'critico');
  const tienePositivos = alertasFiltradas.some(a => ['positivo', 'info'].includes(a.prioridad));
  if (tieneCriticas && !tienePositivos) {
    const positivoSuprimido = suprimidas.find(a => ['positivo', 'info'].includes(a.prioridad) && a.motivo_supresion !== 'descartada_por_el_dueno');
    if (positivoSuprimido) {
      alertasFiltradas.push({ ...positivoSuprimido, id_interno: `${positivoSuprimido.tipo}_balance`, timestamp: new Date().toISOString() });
    }
  }

  return {
    alertas: alertasFiltradas,
    suprimidas: suprimidas.length,
    stats: statsDe(alertasFiltradas),
  };
}

function statsDe(alertasFiltradas) {
  const criticos  = alertasFiltradas.filter(a => ['critico','inconsistencia'].includes(a.prioridad)).length;
  const atencion  = alertasFiltradas.filter(a => ['atencion','ineficiencia'].includes(a.prioridad)).length;
  const positivos = alertasFiltradas.filter(a => ['positivo','info'].includes(a.prioridad)).length;
  const total     = alertasFiltradas.length;
  return {
    total,
    criticos,
    atencion,
    positivos,
    balance_pct: total > 0 ? {
      critico: Math.round((criticos / total) * 100),
      atencion: Math.round((atencion / total) * 100),
      positivo: Math.round((positivos / total) * 100),
    } : null,
  };
}

// ─── Feedback loop ────────────────────────────────────────────────────────────
// El dueño confirma o descarta una alerta → se registra para P7 (EWTA).
// Solo puede tocar alertas de SU negocio. Devuelve false si la alerta no existe o es de otro.

async function registrarFeedback(negocioId, alertaId, feedback) {
  const id = parseInt(alertaId, 10);
  if (!Number.isInteger(id) || id <= 0) return { ok: false };
  const r = await pool.query(
    `UPDATE alertas_gestionadas
     SET feedback_confirmada=$1, feedback_notas=$2, feedback_at=NOW()
     WHERE id=$3 AND negocio_id=$4`,
    [!!feedback.confirmada, feedback.notas || null, id, negocioId]
  );
  return { ok: r.rowCount > 0, id };
}

// ─── Tabla de alertas gestionadas (para setup.js) ────────────────────────────
// Esta función crea la tabla. Llamar desde setup.js.

async function crearTablaAlertas(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS alertas_gestionadas(
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER REFERENCES usuarios(id),
    negocio_id INTEGER,
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
  await pool.query('ALTER TABLE alertas_gestionadas ADD COLUMN IF NOT EXISTS negocio_id INTEGER');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alertas_neg_tipo ON alertas_gestionadas(negocio_id, tipo_alerta, contexto, created_at)');
}

module.exports = { gestionarAlertas, registrarFeedback, crearTablaAlertas };
