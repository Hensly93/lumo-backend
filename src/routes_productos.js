const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const { actualizarBaselineNegocio } = require('./baseline_negocio');
const { cruzarCatalogoConTicket } = require('./cruce_catalogo');
const { auth } = require('./authMiddleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB máx
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Parseo Excel / CSV ───────────────────────────────────────────────────────

function normKey(k) { return String(k).toLowerCase().trim(); }

function getCol(row, keys, patterns) {
  const normKeys = Object.keys(row).map(normKey);
  for (const p of patterns) {
    const idx = normKeys.findIndex(k => k.includes(p));
    if (idx !== -1) return String(Object.values(row)[idx] ?? '').trim();
  }
  return '';
}

function limpiarPrecio(raw) {
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(/[^\d.,]/g, '').replace(',', '.'));
  return isNaN(n) || n <= 0 ? null : n;
}

function parsearFilasExcel(rows) {
  return rows
    .map(row => {
      const nombre    = getCol(row, [], ['nombre', 'producto', 'descripcion', 'description', 'item', 'articulo', 'detalle', 'product']);
      const pvRaw     = getCol(row, [], ['precio venta', 'p.venta', 'pventa', 'precio unitario', 'precio', 'price', 'venta', 'valor unitario', 'valor']);
      const pcRaw     = getCol(row, [], ['precio costo', 'p.costo', 'pcosto', 'costo', 'cost']);
      const categoria = getCol(row, [], ['categoria', 'category', 'rubro', 'tipo', 'familia', 'seccion', 'grupo']);
      const unidad    = getCol(row, [], ['unidad', 'unit', 'um', 'medida', 'presentacion']);

      return {
        nombre,
        categoria:    categoria || null,
        precio_venta: limpiarPrecio(pvRaw),
        precio_costo: limpiarPrecio(pcRaw),
        unidad:       unidad || 'unidad',
      };
    })
    .filter(p => p.nombre.length > 1);
}

function parsearArchivoExcelCSV(buffer, mimetype) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellText: true });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return parsearFilasExcel(rows);
}

// ─── Parseo con Claude (PDF o imagen) ────────────────────────────────────────

const PROMPT_EXTRACCION = `Sos un asistente que extrae listas de productos de archivos de negocios argentinos.
Del texto/imagen que te mando, extraé todos los productos que encuentres.
Devolvé ÚNICAMENTE un JSON array con esta estructura, sin texto adicional:
[
  { "nombre": "string", "categoria": "string o null", "precio_venta": número o null, "precio_costo": número o null, "unidad": "string" }
]
Reglas:
- nombre: requerido, tal como aparece
- categoria: si se puede inferir del contexto, sino null
- precio_venta: precio al público en pesos, solo el número sin símbolo
- precio_costo: precio de costo si aparece, sino null
- unidad: "unidad" por defecto, o lo que indique el archivo (kg, litro, docena, etc.)
- No incluyas productos con nombre vacío o ilegible
- Si hay precios con coma decimal (ej: 1.500,00) interpretá como pesos argentinos`;

async function parsearConClaude(content) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  // Extraer JSON del response (puede venir con ```json ... ```)
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]);
  return parsed
    .filter(p => p.nombre && String(p.nombre).trim().length > 0)
    .map(p => ({
      nombre:       String(p.nombre).trim(),
      categoria:    p.categoria ? String(p.categoria).trim() : null,
      precio_venta: typeof p.precio_venta === 'number' && p.precio_venta > 0 ? p.precio_venta : null,
      precio_costo: typeof p.precio_costo === 'number' && p.precio_costo > 0 ? p.precio_costo : null,
      unidad:       p.unidad ? String(p.unidad).trim() : 'unidad',
    }));
}

async function parsearPDF(buffer) {
  // Extraer texto del PDF con pdf-parse
  let pdfParse;
  try { pdfParse = require('pdf-parse'); } catch { return []; }

  const data = await pdfParse(buffer);
  const texto = data.text?.trim();
  if (!texto || texto.length < 10) return [];

  // Truncar a 8000 chars para no pasarse del contexto
  const contenido = texto.slice(0, 8000);
  return parsearConClaude([
    { type: 'text', text: PROMPT_EXTRACCION + '\n\nTexto del PDF:\n' + contenido },
  ]);
}

async function parsearImagen(buffer, mimetype) {
  const mediaType = mimetype === 'image/png' ? 'image/png'
    : mimetype === 'image/webp' ? 'image/webp'
    : 'image/jpeg';

  return parsearConClaude([
    { type: 'text', text: PROMPT_EXTRACCION },
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

// ─── POST /api/productos/upload-archivo ──────────────────────────────────────
// Parsea y devuelve preview sin guardar
router.post('/upload-archivo', auth, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const { mimetype, buffer, originalname } = req.file;
    const ext = (originalname.split('.').pop() || '').toLowerCase();

    let productos = [];
    let metodo = '';

    if (ext === 'xlsx' || ext === 'xls' || mimetype.includes('spreadsheet') || mimetype.includes('excel')) {
      productos = parsearArchivoExcelCSV(buffer, mimetype);
      metodo = 'excel';
    } else if (ext === 'csv' || mimetype === 'text/csv') {
      productos = parsearArchivoExcelCSV(buffer, mimetype);
      metodo = 'csv';
    } else if (ext === 'pdf' || mimetype === 'application/pdf') {
      productos = await parsearPDF(buffer);
      metodo = 'pdf';
    } else if (mimetype.startsWith('image/')) {
      productos = await parsearImagen(buffer, mimetype);
      metodo = 'imagen';
    } else {
      return res.status(400).json({ error: 'Formato no soportado. Usá .xlsx, .csv, .pdf o imagen.' });
    }

    if (productos.length === 0) {
      return res.status(422).json({ error: 'No se encontraron productos en el archivo. Verificá el formato.' });
    }

    res.json({ productos, total: productos.length, metodo });
  } catch (e) {
    console.error('upload-archivo error:', e.message);
    res.status(500).json({ error: 'Error procesando el archivo: ' + e.message });
  }
});

// ─── POST /api/productos/confirmar ───────────────────────────────────────────
// Guarda el array confirmado por el dueño
router.post('/confirmar', auth, async (req, res) => {
  try {
    const { productos } = req.body;
    if (!Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({ error: 'productos requerido' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let insertados = 0;
      let actualizados = 0;

      for (const p of productos) {
        if (!p.nombre?.trim()) continue;
        // Upsert por (usuario_id, nombre) — si ya existe actualiza precio
        const r = await client.query(
          `INSERT INTO productos(usuario_id, nombre, categoria, precio_venta, precio_costo, unidad)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(usuario_id, nombre)
           DO UPDATE SET
             categoria    = COALESCE(EXCLUDED.categoria, productos.categoria),
             precio_venta = COALESCE(EXCLUDED.precio_venta, productos.precio_venta),
             precio_costo = COALESCE(EXCLUDED.precio_costo, productos.precio_costo),
             unidad       = COALESCE(EXCLUDED.unidad, productos.unidad),
             activo       = true,
             updated_at   = NOW()
           RETURNING (xmax = 0) AS insertado`,
          [req.user.id, p.nombre.trim(), p.categoria || null, p.precio_venta || null, p.precio_costo || null, p.unidad || 'unidad']
        );
        if (r.rows[0].insertado) insertados++; else actualizados++;
      }

      await client.query('COMMIT');
      res.json({ ok: true, insertados, actualizados });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/productos ───────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { categoria, q } = req.query;
    let query = `SELECT id, nombre, categoria, precio_venta, precio_costo, unidad, updated_at
                 FROM productos WHERE usuario_id=$1 AND activo=true`;
    const params = [req.user.id];

    if (categoria) { params.push(categoria); query += ` AND categoria=$${params.length}`; }
    if (q) { params.push(`%${q}%`); query += ` AND nombre ILIKE $${params.length}`; }

    query += ' ORDER BY categoria NULLS LAST, nombre';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/productos/categorias ───────────────────────────────────────────
router.get('/categorias', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT categoria FROM productos WHERE usuario_id=$1 AND activo=true AND categoria IS NOT NULL ORDER BY categoria`,
      [req.user.id]
    );
    res.json(r.rows.map(r => r.categoria));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/productos/:id ─────────────────────────────────────────────────
router.patch('/:id', auth, async (req, res) => {
  try {
    const { nombre, categoria, precio_venta, precio_costo, unidad } = req.body;
    const r = await pool.query(
      `UPDATE productos SET
        nombre       = COALESCE($1, nombre),
        categoria    = COALESCE($2, categoria),
        precio_venta = COALESCE($3, precio_venta),
        precio_costo = COALESCE($4, precio_costo),
        unidad       = COALESCE($5, unidad),
        updated_at   = NOW()
       WHERE id=$6 AND usuario_id=$7
       RETURNING *`,
      [nombre || null, categoria || null, precio_venta ?? null, precio_costo ?? null, unidad || null, req.params.id, req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });

    // Punto 3: recalibrar baseline cuando cambia un precio (fire-and-forget)
    if (precio_venta != null) {
      setImmediate(async () => {
        try {
          const todas = await pool.query(
            'SELECT * FROM transacciones WHERE usuario_id=$1 ORDER BY fecha ASC',
            [req.user.id]
          );
          if (todas.rows.length >= 5) await actualizarBaselineNegocio(req.user.negocio_id, null, todas.rows);
        } catch (e) {
          console.error('[RECALIBRACION PRECIO]', e.message);
        }
      });
    }

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/productos/precios-alertas ───────────────────────────────────────
// Cruce ticket real vs precio promedio del catálogo (señal analítica para NICOLE)
router.get('/precios-alertas', auth, async (req, res) => {
  try {
    const cruce = await cruzarCatalogoConTicket(req.user.negocio_id);
    res.json({ cruce });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/productos/:id ────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE productos SET activo=false WHERE id=$1 AND usuario_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/productos — agregar uno manual ─────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { nombre, categoria, precio_venta, precio_costo, unidad } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'nombre requerido' });
    const r = await pool.query(
      `INSERT INTO productos(usuario_id, nombre, categoria, precio_venta, precio_costo, unidad)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(usuario_id, nombre)
       DO UPDATE SET precio_venta=EXCLUDED.precio_venta, activo=true, updated_at=NOW()
       RETURNING *`,
      [req.user.id, nombre.trim(), categoria || null, precio_venta || null, precio_costo || null, unidad || 'unidad']
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
