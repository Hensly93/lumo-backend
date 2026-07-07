const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const { actualizarBaselineNegocio, getBaselineNegocio } = require('./baseline_negocio');
const { calculateWowMoment } = require('./wow_moment');
const { auth } = require('./authMiddleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB máx
});

// Debug: log API key status at module load
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY no está definida al cargar routes_negocio.js');
} else {
  const keyPreview = process.env.ANTHROPIC_API_KEY.substring(0, 25) + '...';
  console.log('✓ ANTHROPIC_API_KEY cargada:', keyPreview);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Validar que metodo_pago sea solo efectivo o mercado_pago
function esMetodoPagoValido(metodo) {
  if (!metodo) return false;
  const m = String(metodo).toLowerCase().trim();
  return m === 'efectivo' || m === 'mercado_pago' || m === 'mp' || m === 'mercadopago';
}

// Normalizar método de pago a efectivo | mercado_pago
function normalizarMetodoPago(metodo) {
  if (!metodo) return null;
  const m = String(metodo).toLowerCase().trim();
  if (m === 'efectivo') return 'efectivo';
  if (m === 'mp' || m === 'mercadopago' || m === 'mercado_pago') return 'mercado_pago';
  return null;
}

// Parsear Excel / CSV
function parsearArchivoExcelCSV(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellText: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows
    .map(row => {
      const keys = Object.keys(row).map(k => String(k).toLowerCase().trim());

      // Buscar columnas por patrón
      const getCol = (patterns) => {
        for (const p of patterns) {
          const idx = keys.findIndex(k => k.includes(p));
          if (idx !== -1) return String(Object.values(row)[idx] ?? '').trim();
        }
        return '';
      };

      return {
        fecha: getCol(['fecha', 'date', 'fecha_transaccion']),
        hora: getCol(['hora', 'time', 'hora_transaccion']),
        monto: getCol(['monto', 'importe', 'amount', 'total', 'valor']),
        metodo_pago: getCol(['metodo', 'método', 'pago', 'method', 'payment']),
        empleado: getCol(['empleado', 'operador', 'employee', 'name']),
        descripcion: getCol(['descripcion', 'descripción', 'detalle', 'description', 'nota']),
      };
    })
    .filter(t => t.fecha || t.monto);
}

// Parsear con Claude (PDF/Imagen)
const PROMPT_TRANSACCIONES = `Sos un asistente que extrae transacciones de archivos de negocio argentinos.
Del archivo/imagen, extraé TODAS las transacciones registradas.

Devolvé ÚNICAMENTE un JSON array con esta estructura, sin texto adicional:
[
  { "fecha": "YYYY-MM-DD", "hora": "HH:MM", "monto": número, "metodo_pago": "efectivo" o "mercado_pago", "empleado": "nombre", "descripcion": "string opcional" }
]

Reglas CRÍTICAS:
- fecha: YYYY-MM-DD (requerido)
- hora: HH:MM formato 24hs (opcional)
- monto: número positivo, sin símbolo ($). Si está en formato "1.234,50" (pesos argentinos), interpretá como 1234.50
- metodo_pago: SOLO "efectivo" o "mercado_pago" (si dice "MP", "Mercado Pago", "MP", normalizá a "mercado_pago")
- empleado: nombre del operador (opcional)
- descripcion: detalle de la transacción (opcional)

MUY IMPORTANTE:
- RECHAZA cualquier otra forma de pago (tarjeta, transferencia, cheque, etc). Si ves otros métodos, NO los incluyas.
- Si el archivo es confuso, incluye SOLO las transacciones que puedas leer con certeza
- No incluyas encabezados, totales, o líneas de resumen
- Si no encuentras transacciones claras, devolvé []`;

async function parsearConClaude(content) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content }],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function parsearPDF(buffer) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch {
    return [];
  }

  const data = await pdfParse(buffer);
  const texto = data.text?.trim();
  if (!texto || texto.length < 20) return [];

  const contenido = texto.slice(0, 12000);
  return parsearConClaude([
    { type: 'text', text: PROMPT_TRANSACCIONES + '\n\nTexto del PDF:\n' + contenido },
  ]);
}

async function parsearImagen(buffer, mimetype) {
  const mediaType = mimetype === 'image/png' ? 'image/png'
    : mimetype === 'image/webp' ? 'image/webp'
    : 'image/jpeg';

  return parsearConClaude([
    { type: 'text', text: PROMPT_TRANSACCIONES },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: buffer.toString('base64'),
      },
    },
  ]);
}

// Normalizar fecha a YYYY-MM-DD
function normalizarFecha(fechaRaw) {
  if (!fechaRaw) return null;
  const s = String(fechaRaw).trim();

  // Si es timestamp numérico de Excel
  if (!isNaN(fechaRaw) && fechaRaw > 30000) {
    const d = new Date((parseFloat(fechaRaw) - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }

  // Si ya es YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Intentar parsear DD/MM/YYYY o similar
  const matches = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (matches) {
    const [_, d, m, y] = matches;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  return null;
}

// Normalizar hora a HH:MM
function normalizarHora(horaRaw) {
  if (!horaRaw) return null;
  const s = String(horaRaw).trim();

  // Si es HH:MM o HHMM
  const matches = s.match(/(\d{1,2}):?(\d{2})/);
  if (matches) {
    const h = String(matches[1]).padStart(2, '0');
    const m = String(matches[2]).padStart(2, '0');
    return `${h}:${m}`;
  }

  return null;
}

// Normalizar monto a número
function normalizarMonto(montoRaw) {
  if (!montoRaw) return null;
  const s = String(montoRaw).trim();
  const n = parseFloat(s.replace(/[^\d.,]/g, '').replace(',', '.'));
  return isNaN(n) || n <= 0 ? null : n;
}

// POST /api/negocio/upload-historial
router.post('/upload-historial', auth, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

    // Capturar sucursal_id si el frontend lo envía
    const sucursal_id = req.body.sucursal_id ? parseInt(req.body.sucursal_id) : null;

    const { mimetype, buffer, originalname } = req.file;
    const ext = (originalname.split('.').pop() || '').toLowerCase();

    let transacciones = [];

    if (ext === 'xlsx' || ext === 'xls' || mimetype.includes('spreadsheet')) {
      transacciones = parsearArchivoExcelCSV(buffer);
    } else if (ext === 'csv' || mimetype === 'text/csv') {
      transacciones = parsearArchivoExcelCSV(buffer);
    } else if (ext === 'pdf' || mimetype === 'application/pdf') {
      transacciones = await parsearPDF(buffer);
    } else if (mimetype.startsWith('image/')) {
      transacciones = await parsearImagen(buffer, mimetype);
    } else {
      return res.status(400).json({ error: 'Formato no soportado. Usá .xlsx, .csv, .pdf o imagen.' });
    }

    if (transacciones.length === 0) {
      return res.status(422).json({ error: 'No se encontraron transacciones en el archivo.' });
    }

    // Normalizar y validar
    const validadas = [];
    const rechazadas = [];

    for (const t of transacciones) {
      const fecha = normalizarFecha(t.fecha);
      const monto = normalizarMonto(t.monto);
      const metodo_raw = t.metodo_pago;
      const metodo = normalizarMetodoPago(metodo_raw);

      if (!fecha || !monto) {
        rechazadas.push({ raw: t, razon: 'fecha o monto inválido' });
        continue;
      }

      if (!metodo) {
        rechazadas.push({ raw: t, razon: `método de pago no válido: "${metodo_raw}"` });
        continue;
      }

      validadas.push({
        fecha,
        hora: normalizarHora(t.hora),
        monto,
        metodo_pago: metodo,
        empleado: t.empleado ? String(t.empleado).trim().substring(0, 100) : null,
        descripcion: t.descripcion ? String(t.descripcion).trim().substring(0, 200) : null,
      });
    }

    if (validadas.length === 0) {
      return res.status(422).json({
        error: `Ninguna transacción válida. Rechazadas: ${rechazadas.length}`,
        rechazadas,
      });
    }

    // Insertar en DB
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let insertadas = 0;

      for (const t of validadas) {
        await client.query(
          `INSERT INTO transacciones(usuario_id, fecha, monto, metodo_pago, empleado, turno, origen)
           VALUES($1, $2, $3, $4, $5, $6, $7)`,
          [
            req.user.id,
            new Date(`${t.fecha}T${t.hora || '12:00'}:00`),
            t.monto,
            t.metodo_pago,
            t.empleado,
            null,
            'importado',
          ]
        );
        insertadas++;
      }

      await client.query('COMMIT');

      // Calcular métricas
      const metricas = await pool.query(
        `SELECT
           COUNT(*) as total,
           COALESCE(SUM(CASE WHEN metodo_pago='efectivo' THEN monto ELSE 0 END), 0) as total_efectivo,
           COALESCE(SUM(CASE WHEN metodo_pago='mercado_pago' THEN monto ELSE 0 END), 0) as total_mp,
           COUNT(DISTINCT DATE(fecha)) as dias_datos,
           ROUND(AVG(monto)::numeric, 2) as ticket_promedio
         FROM transacciones
         WHERE usuario_id=$1`,
        [req.user.id]
      );

      const m = metricas.rows[0];
      const total_efectivo = parseFloat(m.total_efectivo || 0);
      const total_mp = parseFloat(m.total_mp || 0);
      const total_dinero = total_efectivo + total_mp;
      const ratio_efectivo = total_dinero > 0 ? total_efectivo / total_dinero : 0;
      const dias_datos = parseInt(m.dias_datos);

      // Auto-trigger: recalcular baseline inmediatamente post-importación
      let baseline_status = '⏳ Baseline en construcción';
      let baseline_listo = false;

      try {
        const allTransacciones = await pool.query(
          `SELECT * FROM transacciones WHERE usuario_id=$1 ORDER BY fecha ASC`,
          [req.user.id]
        );

        await actualizarBaselineNegocio(req.user.negocio_id, sucursal_id, allTransacciones.rows);
        console.log('✅ Baseline calculado inmediatamente post-importación');

        // Verificar confianza temporal
        if (dias_datos >= 30) {
          baseline_status = '✅ Baseline LISTO (30+ días)';
          baseline_listo = true;
        } else if (dias_datos >= 8) {
          const dias_faltantes = 8 - dias_datos;
          baseline_status = `⚠️ Baseline en construcción (${dias_faltantes} días más para confianza media)`;
          baseline_listo = true;
        } else {
          const dias_faltantes = 8 - dias_datos;
          baseline_status = `⏳ Datos insuficientes (necesita ${dias_faltantes}+ días)`;
        }
      } catch (error) {
        console.error('⚠️ Baseline no calculado, se hará en job_nocturno:', error.message);
        baseline_status = '⏳ Baseline en construcción (se calculará en próxima ejecución)';
      }

      res.json({
        success: true,
        transacciones_cargadas: insertadas,
        dias_datos,
        total_efectivo: Math.round(total_efectivo),
        total_mercado_pago: Math.round(total_mp),
        ratio_efectivo: Math.round(ratio_efectivo * 100) / 100,
        ticket_promedio: Math.round(parseFloat(m.ticket_promedio) || 0),
        baseline_status,
        baseline_listo,
        mensaje: `${insertadas} transacciones: ${Math.round(ratio_efectivo * 100)}% efectivo, ${Math.round((1 - ratio_efectivo) * 100)}% Mercado Pago. ${baseline_status}`,
        advertencias: rechazadas.length > 0 ? `${rechazadas.length} transacciones rechazadas (métodos de pago no válidos)` : null,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('upload-historial error:', e.message);
    res.status(500).json({ error: 'Error cargando historial: ' + e.message });
  }
});

// ─── GET /api/negocio/wow-moment ──────────────────────────────────────────────
// Devuelve top 3 patrones impactantes del negocio (últimos 30 días)
router.get('/wow-moment', auth, async (req, res) => {
  try {
    const resultado = await calculateWowMoment(req.user.id, pool);
    res.json(resultado);
  } catch (e) {
    console.error('wow-moment error:', e.message);
    res.status(500).json({ error: 'Error calculando patrones: ' + e.message });
  }
});

// ─── GET /api/negocio/wow-moment-ai ───────────────────────────────────────────
// WOW MOMENT con Claude: análisis narrativo de inconsistencias
router.get('/wow-moment-ai', auth, async (req, res) => {
  try {
    // Debug: verificar API key en el momento de la llamada
    console.log('[wow-moment-ai] API Key status:', process.env.ANTHROPIC_API_KEY ? 'PRESENT' : 'MISSING');

    const { negocio_id, id: usuario_id } = req.user;

    // Obtener datos últimos 14 días
    const txRes = await pool.query(
      `SELECT fecha, monto, metodo_pago, empleado, turno
       FROM transacciones
       WHERE negocio_id=$1 AND fecha >= NOW() - INTERVAL '14 days'
       ORDER BY fecha ASC`,
      [negocio_id]
    );

    if (txRes.rows.length < 10) {
      return res.json({
        error: 'Necesitas al menos 10 transacciones en los últimos 14 días'
      });
    }

    // Preparar resumen por día
    const porDia = {};
    txRes.rows.forEach(tx => {
      const fecha = tx.fecha.toISOString().split('T')[0];
      if (!porDia[fecha]) {
        porDia[fecha] = {
          total: 0,
          efectivo: 0,
          mp: 0,
          num_tx: 0,
          empleados: new Set(),
          turnos: new Set()
        };
      }
      porDia[fecha].total += parseFloat(tx.monto);
      porDia[fecha].num_tx++;
      if (tx.metodo_pago === 'efectivo') porDia[fecha].efectivo += parseFloat(tx.monto);
      if (tx.metodo_pago === 'mercado_pago') porDia[fecha].mp += parseFloat(tx.monto);
      if (tx.empleado) porDia[fecha].empleados.add(tx.empleado);
      if (tx.turno) porDia[fecha].turnos.add(tx.turno);
    });

    // Convertir a array y calcular promedios
    const dias = Object.entries(porDia).map(([fecha, d]) => ({
      fecha,
      total: Math.round(d.total),
      efectivo: Math.round(d.efectivo),
      mp: Math.round(d.mp),
      ratio_efectivo: d.total > 0 ? Math.round((d.efectivo / d.total) * 100) : 0,
      num_tx: d.num_tx,
      empleados: Array.from(d.empleados),
      turnos: Array.from(d.turnos)
    }));

    const promedio = Math.round(dias.reduce((sum, d) => sum + d.total, 0) / dias.length);
    const promedioRatio = Math.round(dias.reduce((sum, d) => sum + d.ratio_efectivo, 0) / dias.length);

    // Llamada a Claude
    const prompt = `Sos un analista de negocios experto en detectar inconsistencias operativas en comercios.

Tenés los datos de ventas de un negocio de los últimos ${dias.length} días:

DATOS DIARIOS:
${dias.map(d => `${d.fecha}: $${d.total} (${d.num_tx} tx, ${d.ratio_efectivo}% efectivo, empleados: ${d.empleados.join(', ')})`).join('\n')}

PROMEDIOS:
- Venta diaria promedio: $${promedio}
- Ratio efectivo promedio: ${promedioRatio}%

Tu tarea: detectar el día o patrón MÁS SOSPECHOSO y generar un análisis conciso.

Devolvé SOLO un JSON con este formato exacto:
{
  "headline": "Una frase impactante que resuma la inconsistencia más grave (ej: Pedro vendió 60% menos el martes y solo cobró efectivo)",
  "mejor_dia": { "fecha": "YYYY-MM-DD", "motivo": "Por qué fue el mejor" },
  "peor_dia": { "fecha": "YYYY-MM-DD", "motivo": "Por qué fue el peor o más sospechoso" },
  "inconsistencias": [
    {
      "tipo": "ventas_bajas | ratio_efectivo | empleado_nuevo | etc",
      "descripcion": "Descripción clara y concisa de la anomalía",
      "fecha": "YYYY-MM-DD o rango",
      "empleado": "nombre si es relevante"
    }
  ],
  "impacto_economico": "Frase que cuantifique la pérdida estimada en pesos (ej: Perdiste aproximadamente $15,000 en ese turno anómalo)",
  "recomendacion": "Una acción concreta que el dueño debería tomar YA"
}

IMPORTANTE: Devolvé SOLO el JSON, sin markdown ni texto adicional.`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error('Claude no devolvió JSON válido');
    }

    const analisis = JSON.parse(match[0]);

    res.json({
      success: true,
      analisis,
      datos_base: {
        dias_analizados: dias.length,
        promedio_diario: promedio,
        ratio_efectivo_promedio: promedioRatio
      },
      costo_api: {
        modelo: 'claude-sonnet-4-5',
        tokens_input: msg.usage.input_tokens,
        tokens_output: msg.usage.output_tokens
      }
    });

  } catch (e) {
    console.error('wow-moment-ai error:', e.message);
    res.status(500).json({ error: 'Error generando análisis: ' + e.message });
  }
});

module.exports = router;
