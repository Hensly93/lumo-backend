const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { analizarNegocio } = require('./motor');
const { actualizarBaselineNegocio, getBaselineNegocio } = require('./baseline_negocio');
const { getBenchmarkSector, normalizarTipoNegocio, TIPOS_VALIDOS } = require('./benchmarks_sector');
const { calcularPesos } = require('./benchmark_hibrido');
const { generarPrediccionCompleta } = require('./predicciones');
const { generarRecomendaciones } = require('./recomendaciones');
const { gestionarAlertas, registrarFeedback } = require('./alert_manager');
const { adaptarUmbralPorFeedback, getUmbralesUsuario } = require('./motor_conductual');
const { calcularCUSUMCompleto, resetBaselinePorCambioConfirmado } = require('./cusum');
const { calcularERMNegocio, calcularRiesgoEmpleado } = require('./erm');
const pool = require('./db');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Token invalido' });
  }
}

router.get('/analisis', authMiddleware, async (req, res) => {
  const sucursalId = req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;
  const resultado = await analizarNegocio(req.user.id, sucursalId);
  res.json(resultado);
});

router.post('/transacciones', authMiddleware, async (req, res) => {
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
    await actualizarBaselineNegocio(req.user.id, todas.rows);

    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/perfil', authMiddleware, async (req, res) => {
  try {
    const uResult = await pool.query(
      'SELECT id, nombre, email, negocio, tipo_negocio, created_at FROM usuarios WHERE id = $1',
      [req.user.id]
    );
    const usuario = uResult.rows[0];
    const tipoNegocio = normalizarTipoNegocio(usuario.tipo_negocio || usuario.negocio);

    const [benchmarks, baseline, txCount] = await Promise.all([
      tipoNegocio ? getBenchmarkSector(tipoNegocio) : Promise.resolve({}),
      getBaselineNegocio(req.user.id),
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

router.get('/negocio/perfil', authMiddleware, async (req, res) => {
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
      getBaselineNegocio(req.user.id),
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

// PATCH /api/perfil — actualizar tipo_negocio del usuario
router.patch('/perfil', authMiddleware, async (req, res) => {
  try {
    const { tipo_negocio } = req.body;
    if (!tipo_negocio) return res.status(400).json({ error: 'tipo_negocio requerido' });
    if (!TIPOS_VALIDOS.includes(tipo_negocio)) {
      return res.status(400).json({ error: `Valor inválido. Aceptados: ${TIPOS_VALIDOS.join(', ')}` });
    }
    await pool.query('UPDATE usuarios SET tipo_negocio=$1 WHERE id=$2', [tipo_negocio, req.user.id]);
    res.json({ ok: true, tipo_negocio });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/predicciones — Obj 4+5: proyección facturación + pérdidas
router.get('/predicciones', authMiddleware, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;
    const resultado = await generarPrediccionCompleta(req.user.id, sucursalId);
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recomendaciones — Obj 6: motor de recomendaciones
router.get('/recomendaciones', authMiddleware, async (req, res) => {
  try {
    const resultado = await generarRecomendaciones(req.user.id);
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/alertas/feedback — Obj 7 + P7: feedback loop + EWTA
router.post('/alertas/feedback', authMiddleware, async (req, res) => {
  try {
    const { alerta_id, confirmada, notas } = req.body;
    if (alerta_id == null) return res.status(400).json({ error: 'alerta_id requerido' });
    // 1. Registrar feedback
    await registrarFeedback(alerta_id, { confirmada: !!confirmada, notas });
    // 2. Adaptar umbral EWTA
    const ewta = await adaptarUmbralPorFeedback(req.user.id, alerta_id).catch(() => null);
    // 3. Si es TP confirmado → Baseline Reset Protocol (P8)
    let reset = null;
    if (confirmada) {
      reset = await resetBaselinePorCambioConfirmado(req.user.id).catch(() => null);
    }
    res.json({ ok: true, ewta, reset });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/umbrales — P6+P7: ver umbrales dinámicos actuales
router.get('/umbrales', authMiddleware, async (req, res) => {
  try {
    const umbrales = await getUmbralesUsuario(req.user.id);
    res.json({ umbrales, default: 2.5 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ventas-diarias?dias=30 — ventas reales por día para el gráfico
router.get('/ventas-diarias', authMiddleware, async (req, res) => {
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

// GET /api/alertas — Obj 7 + P8: pipeline alertas + CUSUM
router.get('/alertas', authMiddleware, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;
    const [analisis, cusum] = await Promise.all([
      analizarNegocio(req.user.id, sucursalId),
      calcularCUSUMCompleto(req.user.id, sucursalId).catch(() => ({ alertas_cusum: [] })),
    ]);
    const candidatas = [
      ...(analisis.señales || []),
      ...(cusum.alertas_cusum || []),
    ];
    const resultado = await gestionarAlertas(req.user.id, candidatas);
    res.json({ ...resultado, cusum: cusum.turnos });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/erm — ERM completo del negocio (todos los empleados)
router.get('/erm', authMiddleware, async (req, res) => {
  try {
    const resultado = await calcularERMNegocio(req.user.id);
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/erm/:empleado — ERM de un empleado específico
router.get('/erm/:empleado', authMiddleware, async (req, res) => {
  try {
    const resultado = await calcularRiesgoEmpleado(req.user.id, req.params.empleado);
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
