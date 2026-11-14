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

// NOTA: No crear cliente Anthropic aquí a nivel módulo
// Se crea dentro de cada función que lo necesita para capturar la key en runtime

// Validar que metodo_pago sea solo efectivo o mercado_pago
function esMetodoPagoValido(metodo) {
  if (!metodo) return false;
  const m = String(metodo).toLowerCase().trim();
  return m === 'efectivo' || m === 'mercado_pago' || m === 'mp' || m === 'mercadopago';
}

// Normalizar método de pago a efectivo | mercado_pago
function normalizarMetodoPago(metodo) {
  if (!metodo) return null;
  // sin tildes, espacios ni guiones: "Débito", "mercado pago", "Mercado_Pago" -> debito, mercadopago
  const m = String(metodo).toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
  if (m === 'efectivo' || m === 'cash') return 'efectivo';
  if (m === 'mp' || m === 'mercadopago') return 'mercado_pago';
  if (m === 'debito' || m === 'tarjetadebito') return 'debito';
  if (m === 'credito' || m === 'tarjetacredito') return 'credito';
  if (m === 'tarjeta') return 'tarjeta';
  if (m === 'transferencia' || m === 'transf') return 'transferencia';
  if (m === 'qr') return 'qr';
  return null;
}

// Parsear Excel / CSV
function parsearArchivoExcelCSV(buffer) {
  // Excel (.xlsx/.xls) viene en binario; el CSV es texto. El CSV se decodifica a mano para no romper
  // las tildes (UTF-8 o Windows-1252, que es lo que exporta Excel en Argentina) ni convertir "3.500" en 3,5.
  const esBinario = (buffer[0] === 0x50 && buffer[1] === 0x4b) || (buffer[0] === 0xd0 && buffer[1] === 0xcf);
  let workbook;
  if (esBinario) {
    workbook = XLSX.read(buffer, { type: 'buffer', cellText: false });
  } else {
    let texto;
    try {
      texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      texto = new TextDecoder('windows-1252').decode(buffer);
    }
    if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
    workbook = XLSX.read(texto, { type: 'string', raw: true });
  }
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
  { "fecha": "YYYY-MM-DD", "hora": "HH:MM", "monto": número, "metodo_pago": "efectivo", "empleado": "nombre", "descripcion": "string opcional" }
]

Reglas CRÍTICAS:
- fecha: YYYY-MM-DD (requerido)
- hora: HH:MM formato 24hs (opcional)
- monto: número positivo, sin símbolo ($). Si está en formato "1.234,50" (pesos argentinos), interpretá como 1234.50
- metodo_pago: uno de "efectivo", "mercado_pago" (si dice "MP" o "Mercado Pago"), "debito", "credito", "transferencia" o "qr". Si el medio de pago no figura en el archivo, omití ese campo
- empleado: nombre del operador (opcional)
- descripcion: detalle de la transacción (opcional)

MUY IMPORTANTE:
- Si el medio de pago es otro (cheque, cuenta corriente, fiado), NO incluyas esa transacción.
- Si el archivo trae un total por día y no ventas sueltas, devolvé una transacción por día con ese total. Si ese total viene separado por medio de pago, una por día y por medio de pago.
- Los importes tienen que quedar en pesos. Si el archivo dice "en miles" o "en millones de pesos", multiplicalos.
- Si el documento es solo un resumen mensual, por rubro o por sucursal (sin ventas por día ni ventas sueltas), devolvé [].
- Omití los campos que no figuren en el archivo: no los completes con null ni con texto vacío.
- Si el archivo es confuso, incluye SOLO las transacciones que puedas leer con certeza
- No incluyas encabezados, totales, o líneas de resumen
- Si no encuentras transacciones claras, devolvé []`;

async function parsearConClaude(content) {
  // Debug: verificar que ANTHROPIC_API_KEY existe en runtime
  console.log('[parsearConClaude] ANTHROPIC_API_KEY en runtime:',
    process.env.ANTHROPIC_API_KEY ?
    'existe, longitud: ' + process.env.ANTHROPIC_API_KEY.length :
    'undefined');

  // Crear cliente Anthropic en runtime para capturar API key correctamente
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16000,
    messages: [{ role: 'user', content }],
  });
  require('./ia_presupuesto').registrarUso({ funcion: 'importar_ventas', modelo: msg.model, usage: msg.usage });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  // Si la respuesta se cortó a la mitad, nos quedamos con las transacciones completas que llegaron.
  const ini = text.indexOf('[');
  if (ini === -1) return [];
  let recortado = false;
  let candidato = text.slice(ini);
  const fin = candidato.lastIndexOf(']');
  if (fin !== -1) {
    candidato = candidato.slice(0, fin + 1);
  } else {
    recortado = true;
    const ultimo = candidato.lastIndexOf('}');
    if (ultimo === -1) return [];
    candidato = candidato.slice(0, ultimo + 1) + ']';
  }
  const match = [candidato];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    if (recortado || msg.stop_reason === 'max_tokens') parsed.truncado = true;
    return parsed;
  } catch {
    return [];
  }
}

const MAX_PAGINAS_PDF = 25;

async function parsearPDF(buffer) {
  // Cantidad de paginas: con pdf-parse si esta instalado; si no, se cuentan en el archivo.
  let paginas = 0;
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    paginas = data.numpages || 0;
  } catch {
    paginas = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  }
  if (paginas > MAX_PAGINAS_PDF) {
    const err = new Error(`El PDF tiene ${paginas} páginas y es demasiado largo para leerlo de una vez (máximo ${MAX_PAGINAS_PDF}). Subí el Excel con las ventas, o un PDF solo con las páginas del detalle de ventas.`);
    err.status = 413;
    throw err;
  }

  // Siempre se manda el PDF entero para que Claude lo lea como pagina: al sacar solo el texto,
  // las columnas de las tablas quedan pegadas (01/08/2026sab1.11677116.015.200...) y no se pueden separar.
  return parsearConClaude([
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
    { type: 'text', text: PROMPT_TRANSACCIONES },
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
  const matches = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (matches) {
    const [_, d, m, y0] = matches;
    const y = y0.length === 2 ? '20' + y0 : y0;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  return null;
}

// Normalizar hora a HH:MM
function normalizarHora(horaRaw) {
  if (!horaRaw) return null;
  const s = String(horaRaw).trim();

  // Excel guarda la hora como fraccion del dia (0.5 = 12:00)
  if (/^0?\.\d+$/.test(s)) {
    const minutos = Math.round(parseFloat(s) * 1440);
    return String(Math.floor(minutos / 60) % 24).padStart(2, '0') + ':' + String(minutos % 60).padStart(2, '0');
  }

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
  let s = String(montoRaw).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const ultPunto = s.lastIndexOf('.');
  const ultComa = s.lastIndexOf(',');
  if (ultPunto !== -1 && ultComa !== -1) {
    // los dos separadores: el que va ultimo es el decimal ("1.234,50" o "1,234.50")
    s = ultComa > ultPunto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (ultComa !== -1) {
    // solo coma: "1234,50" decimal; "1,234" o "1,234,567" miles
    s = /,\d{1,2}$/.test(s) && s.indexOf(',') === ultComa ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (ultPunto !== -1) {
    // solo punto: "1234.50" decimal; "1.234" o "12.345.678" miles
    const miles = /\.\d{3}$/.test(s) && (s.indexOf('.') !== ultPunto || ultPunto <= 3);
    s = miles ? s.replace(/\./g, '') : s;
  }
  const n = parseFloat(s);
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

      if (!metodo && metodo_raw && String(metodo_raw).trim() !== '') {
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

      let duplicadas = 0;
      const negocioId = req.user.negocio_id;
      const sucursalId = Number.isInteger(sucursal_id) ? sucursal_id : null;

      // Las horas del archivo son de Argentina (UTC-3). Se guardan en UTC, igual que el resto del sistema.
      const filasNuevas = [];
      for (const t of validadas) {
        const instante = new Date(`${t.fecha}T${t.hora || '12:00'}:00-03:00`);
        if (isNaN(instante.getTime())) {
          rechazadas.push({ raw: t, razon: 'fecha u hora inválida' });
          continue;
        }
        filasNuevas.push({ ...t, instante, ms: instante.getTime() });
      }

      if (filasNuevas.length === 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'No se pudo leer ninguna fecha u hora válida del archivo.', rechazadas });
      }

      // Si ya cargaron estas mismas ventas (por ejemplo, el mismo archivo dos veces) no se repiten.
      // Las repetidas dentro del mismo archivo se respetan: pueden ser ventas distintas del mismo importe.
      const clave = (ms, monto, metodo, empleado) => ms + '|' + Number(monto).toFixed(2) + '|' + (metodo || '') + '|' + (empleado || '');
      const minMs = filasNuevas.reduce((a, f) => Math.min(a, f.ms), Infinity) - 86400000;
      const maxMs = filasNuevas.reduce((a, f) => Math.max(a, f.ms), -Infinity) + 86400000;
      const previas = await client.query(
        `SELECT (EXTRACT(EPOCH FROM (fecha AT TIME ZONE 'UTC')) * 1000)::bigint AS ms, monto, metodo_pago, empleado
           FROM transacciones
          WHERE negocio_id = $1 AND origin = 'importado'
            AND fecha BETWEEN ($2::timestamptz AT TIME ZONE 'UTC') AND ($3::timestamptz AT TIME ZONE 'UTC')`,
        [negocioId, new Date(minMs).toISOString(), new Date(maxMs).toISOString()]
      );
      const yaCargadas = new Map();
      for (const p of previas.rows) {
        const k = clave(Number(p.ms), p.monto, p.metodo_pago, p.empleado);
        yaCargadas.set(k, (yaCargadas.get(k) || 0) + 1);
      }
      const vistas = new Map();
      const paraInsertar = [];
      for (const f of filasNuevas) {
        const k = clave(f.ms, f.monto, f.metodo_pago, f.empleado);
        const n = (vistas.get(k) || 0) + 1;
        vistas.set(k, n);
        if (n <= (yaCargadas.get(k) || 0)) { duplicadas++; continue; }
        paraInsertar.push(f);
      }

      for (let i = 0; i < paraInsertar.length; i += 500) {
        const lote = paraInsertar.slice(i, i + 500);
        await client.query(
          `INSERT INTO transacciones(negocio_id, usuario_id, fecha, monto, tipo, metodo_pago, empleado, origin, sucursal_id)
           SELECT $1::int, $2::int, (u.f AT TIME ZONE 'UTC'), u.m, 'venta', u.mp, u.e, 'importado', $7::int
             FROM unnest($3::timestamptz[], $4::numeric[], $5::text[], $6::text[]) AS u(f, m, mp, e)`,
          [
            negocioId,
            req.user.id,
            lote.map((f) => f.instante.toISOString()),
            lote.map((f) => f.monto),
            lote.map((f) => f.metodo_pago),
            lote.map((f) => f.empleado),
            sucursalId,
          ]
        );
        insertadas += lote.length;
      }

      await client.query('COMMIT');

      // Calcular métricas
      const metricas = await pool.query(
        `SELECT
           COUNT(*) as total,
           COALESCE(SUM(CASE WHEN metodo_pago='efectivo' THEN monto ELSE 0 END), 0) as total_efectivo,
           COALESCE(SUM(CASE WHEN metodo_pago IS NOT NULL AND metodo_pago<>'efectivo' THEN monto ELSE 0 END), 0) as total_mp,
           COUNT(DISTINCT DATE(fecha)) as dias_datos,
           ROUND(AVG(monto)::numeric, 2) as ticket_promedio
         FROM transacciones
         WHERE (negocio_id=$1 OR (negocio_id IS NULL AND usuario_id=$2))
           AND COALESCE(origin,'real') IN ('real','importado')`,
        [negocioId, req.user.id]
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
          `SELECT * FROM transacciones WHERE (negocio_id=$1 OR (negocio_id IS NULL AND usuario_id=$2)) ORDER BY fecha ASC`,
          [negocioId, req.user.id]
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
        duplicadas_omitidas: duplicadas,
        dias_datos,
        total_efectivo: Math.round(total_efectivo),
        total_mercado_pago: Math.round(total_mp),
        ratio_efectivo: Math.round(ratio_efectivo * 100) / 100,
        ticket_promedio: Math.round(parseFloat(m.ticket_promedio) || 0),
        baseline_status,
        baseline_listo,
        mensaje: `${insertadas} ventas cargadas.`,
        advertencias: [
          rechazadas.length > 0 ? `${rechazadas.length} filas no se pudieron leer (fecha, importe o medio de pago no reconocidos).` : null,
          transacciones.truncado ? 'El archivo era muy largo y solo se leyó una parte. Subí el resto en otro archivo (por ejemplo, por mes).' : null,
        ].filter(Boolean).join(' ') || null,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('upload-historial error:', e.message);
    if (e.status === 413) return res.status(413).json({ error: e.message });
    res.status(500).json({ error: 'Error cargando historial: ' + e.message });
  }
});

// ─── GET /api/negocio/wow-moment ──────────────────────────────────────────────
// Devuelve top 3 patrones impactantes del negocio (últimos 30 días)
router.get('/wow-moment', auth, async (req, res) => {
  try {
    const resultado = await calculateWowMoment(req.user.id, pool, req.user.negocio_id);
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

    // Debug: verificar que ANTHROPIC_API_KEY existe en runtime
    console.log('[wow-moment-ai] ANTHROPIC_API_KEY en runtime:',
      process.env.ANTHROPIC_API_KEY ?
      'existe, longitud: ' + process.env.ANTHROPIC_API_KEY.length :
      'undefined');

    // Crear cliente Anthropic en runtime para capturar API key correctamente
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await anthropic.messages.create({
      model: await require('./ia_presupuesto').modeloPara('claude-sonnet-4-5'),
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
    require('./ia_presupuesto').registrarUso({ funcion: 'wow_moment', modelo: msg.model, usage: msg.usage });
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
