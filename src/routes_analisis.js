const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { analizarNegocio } = require('./motor');
const { actualizarBaselineNegocio, getBaselineNegocio } = require('./baseline_negocio');
const { getBenchmarkSector, normalizarTipoNegocio, TIPOS_VALIDOS } = require('./benchmarks_sector');
const { calcularPesos } = require('./benchmark_hibrido');
const { calcularPrediccion } = require('./prediccion_adaptativa');
const { generarMensajePrediccion } = require('./prediccion_mensaje');
const { generarRecomendaciones } = require('./recomendaciones');
const { gestionarAlertas, registrarFeedback } = require('./alert_manager');
const { adaptarUmbralPorFeedback, getUmbralesUsuario } = require('./motor_conductual');
const { calcularCUSUMCompleto, resetBaselinePorCambioConfirmado } = require('./cusum');
const { calcularERMNegocio, calcularRiesgoEmpleado } = require('./erm');
const { notificarUsuario } = require('./push');
const pool = require('./db');
const { auth } = require('./authMiddleware');

router.get('/analisis', auth, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;
    const resultado = await analizarNegocio(req.user.negocio_id, sucursalId);
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/transacciones', auth, async (req, res) => {
  try {
    const { monto, tipo, empleado, turno, fecha, metodo_pago, sucursal_id } = req.body;
    const result = await pool.query(
      'INSERT INTO transacciones(usuario_id, monto, tipo, empleado, turno, fecha, metodo_pago, sucursal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.user.id, monto, tipo, empleado, turno, fecha || new Date(), metodo_pago || null, sucursal_id || null]
    );

    // Actualizar baseline propio (Capa 2) con cada nueva transacción
    const todas = await pool.query(
      'SELECT * FROM transacciones WHERE usuario_id = $1 ORDER BY fecha ASC',
      [req.user.id]
    );
    // Actualizar baseline de la sucursal específica (o global si sucursal_id es null)
    await actualizarBaselineNegocio(req.user.negocio_id, sucursal_id || null, todas.rows);

    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/perfil', auth, async (req, res) => {
  try {
    const uResult = await pool.query(
      'SELECT id, nombre, email, negocio, tipo_negocio, created_at FROM usuarios WHERE id = $1',
      [req.user.id]
    );
    const usuario = uResult.rows[0];
    const tipoNegocio = normalizarTipoNegocio(usuario.tipo_negocio || usuario.negocio);

    const [benchmarks, baseline, txCount] = await Promise.all([
      tipoNegocio ? getBenchmarkSector(tipoNegocio) : Promise.resolve({}),
      getBaselineNegocio(req.user.negocio_id, null),
      pool.query('SELECT COUNT(*) FROM transacciones WHERE usuario_id = $1', [req.user.id]),
    ]);

    // Formatear benchmarks como array para el frontend
    const benchmarks_sector = Object.entries(benchmarks).map(([metrica, b]) => ({
      metrica,
      valor_min:      Number(b.valor_min),
      valor_max:      Number(b.valor_max),
      valor_promedio: Number(b.valor_promedio),
      fuente:         b.fuente,
    }));

    // Baseline propio: sólo las métricas ya calculadas
    const baseline_propio = Object.entries(baseline).map(([metrica, b]) => ({
      metrica,
      valor:                Number(b.valor),
      total_transacciones:  Number(b.total_transacciones),
      updated_at:           b.updated_at,
    }));

    res.json({
      usuario: {
        id:           usuario.id,
        nombre:       usuario.nombre,
        email:        usuario.email,
        negocio:      usuario.negocio,
        tipo_negocio: usuario.tipo_negocio,
        created_at:   usuario.created_at,
      },
      tipo_negocio_normalizado: tipoNegocio,
      tipos_validos:            TIPOS_VALIDOS,
      total_transacciones:      Number(txCount.rows[0].count),
      benchmarks_sector,
      baseline_propio,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/negocio/perfil', auth, async (req, res) => {
  try {
    const [uResult, txResult] = await Promise.all([
      pool.query('SELECT negocio, tipo_negocio FROM usuarios WHERE id = $1', [req.user.id]),
      pool.query('SELECT COUNT(*) FROM transacciones WHERE usuario_id = $1', [req.user.id]),
    ]);

    const { negocio, tipo_negocio } = uResult.rows[0] || {};
    const tipoNegocio = normalizarTipoNegocio(tipo_negocio || negocio);
    const totalTx = Number(txResult.rows[0].count);

    const [benchmarks, baseline] = await Promise.all([
      tipoNegocio ? getBenchmarkSector(tipoNegocio) : Promise.resolve({}),
      getBaselineNegocio(req.user.negocio_id, null),
    ]);

    const pesos = calcularPesos(totalTx);
    const TX_CAPA2_COMPLETA = 500;

    const capa_1 = Object.entries(benchmarks).map(([metrica, b]) => ({
      metrica,
      valor_min:      Number(b.valor_min),
      valor_max:      Number(b.valor_max),
      valor_promedio: Number(b.valor_promedio),
      fuente:         b.fuente,
    }));

    const capa_2 = Object.entries(baseline).map(([metrica, b]) => ({
      metrica,
      valor_actual:        Number(b.valor),
      total_transacciones: Number(b.total_transacciones),
      updated_at:          b.updated_at,
    }));

    res.json({
      tipo_negocio:            tipo_negocio || null,
      tipo_negocio_normalizado: tipoNegocio,
      capa_1,
      capa_2,
      capas: {
        total_transacciones:          totalTx,
        peso_capa_1:                  Math.round(pesos.peso_capa1 * 100),
        peso_capa_2:                  Math.round(pesos.peso_capa2 * 100),
        progreso_capa_2:              `${totalTx}/${TX_CAPA2_COMPLETA}`,
        porcentaje_progreso_capa_2:   Math.min(Math.round((totalTx / TX_CAPA2_COMPLETA) * 100), 100),
        transacciones_restantes:      Math.max(TX_CAPA2_COMPLETA - totalTx, 0),
        capa_2_completa:              totalTx >= TX_CAPA2_COMPLETA,
      },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/perfil — actualizar tipo_negocio y/o onboarding_done
router.patch('/perfil', auth, async (req, res) => {
  try {
    const { tipo_negocio, onboarding_done, provincia, ciudad, zona } = req.body;
    if (tipo_negocio === undefined && onboarding_done === undefined && provincia === undefined && ciudad === undefined && zona === undefined) {
      return res.status(400).json({ error: 'Se requiere al menos un campo para actualizar' });
    }
    if (tipo_negocio !== undefined) {
      if (!TIPOS_VALIDOS.includes(tipo_negocio)) {
        return res.status(400).json({ error: `Tipo inválido. Opciones: ${TIPOS_VALIDOS.join(', ')}` });
      }
      await pool.query('UPDATE usuarios SET tipo_negocio=$1 WHERE id=$2', [tipo_negocio, req.user.id]);
    }
    if (onboarding_done !== undefined) {
      await pool.query('UPDATE usuarios SET onboarding_done=$1 WHERE id=$2', [!!onboarding_done, req.user.id]);
    }
    if (provincia !== undefined || ciudad !== undefined || zona !== undefined) {
      const sets = [];
      const vals = [];
      if (provincia !== undefined) { sets.push(`provincia=$${sets.length + 1}`); vals.push(provincia); }
      if (ciudad !== undefined)    { sets.push(`ciudad=$${sets.length + 1}`);    vals.push(ciudad); }
      if (zona !== undefined)      { sets.push(`zona=$${sets.length + 1}`);      vals.push(zona); }
      vals.push(req.user.id);
      await pool.query(`UPDATE usuarios SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/predicciones — S9: motor adaptativo W1/W2/W3 + mensaje NICOLE
router.get('/predicciones', auth, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;

    const prediccion = await calcularPrediccion(req.user.id, sucursalId);
    if (!prediccion.disponible) return res.json(prediccion);

    // Obtener datos del negocio para el mensaje de NICOLE
    const uRes = await pool.query(
      'SELECT tipo_negocio, zona, ciudad, negocio FROM usuarios WHERE id = $1',
      [req.user.id]
    );
    const u = uRes.rows[0] ?? {};
    const negocio = {
      tipo_negocio:   u.tipo_negocio,
      zona:           u.zona,
      ciudad:         u.ciudad,
      nombre_negocio: u.negocio,
    };

    // Historial reciente: últimas 3 predicciones con error real
    const histRes = await pool.query(
      `SELECT pn.fecha_target, pn.valor_predicho, hp.error_porcentual
       FROM predicciones_negocio pn
       JOIN historial_predicciones hp ON hp.prediccion_id = pn.id
       WHERE pn.usuario_id = $1
         AND ($2::integer IS NULL OR pn.sucursal_id = $2)
       ORDER BY pn.fecha_prediccion DESC
       LIMIT 3`,
      [req.user.id, sucursalId]
    );
    const historial_reciente = histRes.rows;

    // Generar mensaje NICOLE para la primera predicción guardada
    const primeraId = await pool.query(
      `SELECT id FROM predicciones_negocio
       WHERE usuario_id = $1 AND fecha_prediccion = CURRENT_DATE
         AND ($2::integer IS NULL OR sucursal_id = $2)
       ORDER BY id ASC LIMIT 1`,
      [req.user.id, sucursalId]
    );

    let mensaje_nicole = null;
    if (primeraId.rows.length) {
      const r = await generarMensajePrediccion(primeraId.rows[0].id, negocio, pool, historial_reciente);
      mensaje_nicole = r.mensaje;
    }

    res.json({ ...prediccion, mensaje_nicole });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recomendaciones — Obj 6: motor de recomendaciones
router.get('/recomendaciones', auth, async (req, res) => {
  try {
    const resultado = await generarRecomendaciones(req.user.id);
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/alertas/feedback — Obj 7 + P7: feedback loop + EWTA
router.post('/alertas/feedback', auth, async (req, res) => {
  try {
    const { alerta_id, confirmada, notas } = req.body;
    if (alerta_id == null) return res.status(400).json({ error: 'alerta_id requerido' });
    // 1. Registrar feedback
    await registrarFeedback(alerta_id, { confirmada: !!confirmada, notas });
    // 2. Adaptar umbral EWTA
    const ewta = await adaptarUmbralPorFeedback(req.user.negocio_id, alerta_id).catch(() => null);
    // 3. Si es TP confirmado → Baseline Reset Protocol (P8)
    let reset = null;
    if (confirmada) {
      reset = await resetBaselinePorCambioConfirmado(req.user.negocio_id).catch(() => null);
    }
    res.json({ ok: true, ewta, reset });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/umbrales — P6+P7: ver umbrales dinámicos actuales
router.get('/umbrales', auth, async (req, res) => {
  try {
    const umbrales = await getUmbralesUsuario(req.user.negocio_id);
    res.json({ umbrales, default: 2.5 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ventas-diarias?dias=30 — ventas reales por día para el gráfico
router.get('/ventas-diarias', auth, async (req, res) => {
  try {
    const dias = Math.min(parseInt(req.query.dias) || 30, 90);
    const result = await pool.query(
      `SELECT
         DATE(fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') as dia,
         SUM(monto) as total,
         COUNT(*) as transacciones
       FROM transacciones
       WHERE usuario_id=$1
         AND fecha >= NOW() - INTERVAL '${dias} days'
       GROUP BY dia
       ORDER BY dia ASC`,
      [req.user.id]
    );
    res.json({ dias: result.rows.map(r => ({
      dia: r.dia,
      total: parseFloat(r.total),
      transacciones: parseInt(r.transacciones),
    }))});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/alertas — motor unificado: métricas + CUSUM + deduplicación
router.get('/alertas', auth, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;
    const analisis = await analizarNegocio(req.user.negocio_id, sucursalId);
    const resultado = await gestionarAlertas(req.user.negocio_id, analisis.señales || []);
    res.json({ ...resultado, cusum: analisis.cusum });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/nicole/chat — chat conversacional con NICOLE
router.post('/nicole/chat', auth, async (req, res) => {
  try {
    const { mensaje, historial = [] } = req.body;
    if (!mensaje?.trim()) return res.status(400).json({ error: 'mensaje requerido' });

    // Armar contexto completo del negocio en paralelo
    const [uRes, ventasRes, empleadosRes, alertasRes, predRes] = await Promise.all([

      // Perfil
      pool.query(
        'SELECT negocio, tipo_negocio, ciudad, zona FROM usuarios WHERE id=$1',
        [req.user.id]
      ),

      // Ventas últimos 30 días — total, ticket promedio, por día
      pool.query(
        `SELECT
           COUNT(*)                            AS total_tx,
           COALESCE(SUM(monto), 0)             AS total_ventas,
           COALESCE(AVG(monto), 0)             AS ticket_promedio,
           DATE(fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') AS dia,
           SUM(monto)                          AS venta_dia
         FROM transacciones
         WHERE usuario_id=$1 AND fecha >= NOW() - INTERVAL '30 days'
         GROUP BY dia
         ORDER BY dia ASC`,
        [req.user.id]
      ),

      // Empleados: ticket promedio y ratio efectivo por turno
      pool.query(
        `SELECT
           empleado,
           turno,
           COUNT(*)                                                      AS transacciones,
           COALESCE(AVG(monto), 0)                                       AS ticket_promedio,
           COALESCE(
             SUM(CASE WHEN LOWER(metodo_pago) = 'efectivo' THEN 1 ELSE 0 END)::float
             / NULLIF(SUM(CASE WHEN metodo_pago IS NOT NULL THEN 1 ELSE 0 END), 0),
             0
           )                                                             AS ratio_efectivo
         FROM transacciones
         WHERE usuario_id=$1
           AND empleado IS NOT NULL
           AND fecha >= NOW() - INTERVAL '30 days'
         GROUP BY empleado, turno
         ORDER BY empleado, turno`,
        [req.user.id]
      ),

      // Alertas últimos 7 días
      pool.query(
        `SELECT tipo, prioridad, mensaje, timestamp
         FROM alertas
         WHERE usuario_id=$1
           AND descartada = false
           AND timestamp >= NOW() - INTERVAL '7 days'
         ORDER BY timestamp DESC
         LIMIT 5`,
        [req.user.id]
      ).catch(() => ({ rows: [] })),

      // Predicción activa más reciente
      pool.query(
        `SELECT fecha_target, valor_predicho, confianza, horizonte, mensaje_nicole
         FROM predicciones_negocio
         WHERE usuario_id=$1
           AND fecha_target >= CURRENT_DATE
         ORDER BY fecha_prediccion DESC, fecha_target ASC
         LIMIT 1`,
        [req.user.id]
      ).catch(() => ({ rows: [] })),
    ]);

    const u = uRes.rows[0] ?? {};

    // Resumir ventas
    const dias = ventasRes.rows;
    const totalVentas = dias.reduce((a, r) => a + parseFloat(r.venta_dia), 0);
    const ticketProm  = dias.length ? dias.reduce((a, r) => a + parseFloat(r.ticket_promedio), 0) / dias.length : 0;
    const ventasStr   = dias.length
      ? `Total 30d: $${Math.round(totalVentas).toLocaleString('es-AR')}, ticket promedio: $${Math.round(ticketProm).toLocaleString('es-AR')}, días con ventas: ${dias.length}`
      : 'sin ventas registradas en los últimos 30 días';

    // Resumir empleados
    const empleadosStr = empleadosRes.rows.length
      ? empleadosRes.rows.map(e =>
          `${e.empleado} (${e.turno || 'sin turno'}): ticket $${Math.round(e.ticket_promedio).toLocaleString('es-AR')}, efectivo ${Math.round(e.ratio_efectivo * 100)}%, ${e.transacciones} tx`
        ).join(' | ')
      : 'sin datos de empleados';

    // Resumir alertas
    const alertasStr = alertasRes.rows.length
      ? alertasRes.rows.map(r => `[${r.prioridad}] ${r.mensaje}`).join(' | ')
      : 'ninguna';

    // Predicción activa
    const pred = predRes.rows[0];
    const predStr = pred
      ? `Próxima predicción: $${Math.round(pred.valor_predicho).toLocaleString('es-AR')} para ${pred.fecha_target} (confianza ${Math.round(pred.confianza * 100)}%, horizonte ${pred.horizonte})${pred.mensaje_nicole ? '. ' + pred.mensaje_nicole : ''}`
      : 'sin predicción activa';

    const systemPrompt = `Sos NICOLE, la IA de Lumo. Tu nombre es NICOLE, no sos ChatGPT ni Claude. Solo hablás sobre el negocio del dueño usando los datos reales que te paso. Español rioplatense informal, tono de socia de confianza, nunca decís fraude, siempre en pesos argentinos, máximo 5 líneas por respuesta.

DATOS DEL NEGOCIO (hoy ${new Date().toLocaleDateString('es-AR')}):
Perfil: ${u.negocio || 'sin nombre'} · ${u.tipo_negocio || 'tipo desconocido'} · ${u.ciudad || 'sin ciudad'}${u.zona ? ` zona ${u.zona}` : ''}
Ventas 30d: ${ventasStr}
Empleados: ${empleadosStr}
Alertas 7d: ${alertasStr}
Predicción: ${predStr}`;

    // Normalizar historial — acepta {rol, texto} y {role, content}
    const normalizar = (m) => {
      const rawRole = m.role ?? m.rol ?? 'user';
      const content  = m.content ?? m.texto ?? '';
      const role     = rawRole === 'nicole' || rawRole === 'assistant' ? 'assistant' : 'user';
      return { role, content };
    };

    const messages = [
      ...historial.slice(-10).map(normalizar),
      { role: 'user', content: mensaje },
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API ${response.status}: ${err}`);
    }

    const data = await response.json();
    const respuesta = data.content?.find(b => b.type === 'text')?.text?.trim() ?? 'No pude generar una respuesta. Intentá de nuevo.';
    res.json({ respuesta });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/push/subscribe — guardar suscripción push del navegador
router.post('/push/subscribe', auth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'endpoint y keys requeridos' });
    }
    await pool.query(
      `INSERT INTO push_subscriptions(usuario_id, endpoint, p256dh, auth)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh=$3, auth=$4`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/push/subscribe — cancelar suscripción
router.delete('/push/subscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await pool.query(
      'DELETE FROM push_subscriptions WHERE usuario_id=$1 AND endpoint=$2',
      [req.user.id, endpoint]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/erm — ERM completo del negocio (todos los empleados)
router.get('/erm', auth, async (req, res) => {
  try {
    const resultado = await calcularERMNegocio(req.user.id);
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/erm/:empleado — ERM de un empleado específico
router.get('/erm/:empleado', auth, async (req, res) => {
  try {
    const resultado = await calcularRiesgoEmpleado(req.user.id, req.params.empleado);
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
