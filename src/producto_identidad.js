// producto_identidad.js — que "Alf maicena", "alfajor mna" y "aljafol maizena" (o "Galleta orio" y "Galletita oreo") sean el MISMO producto.
// Todo es determinístico y barato: se normaliza el texto (sin tildes, abreviaturas, plurales), cada palabra se compara tolerando errores de
// tipeo, y las marcas conocidas del negocio se reconocen aunque estén mal escritas. Los tamaños (500 ml, 1,5 l, 2 kg) nunca se confunden:
// "Coca 500 ml" y "Coca 1,5 l" son productos distintos. LumoBi PROPONE unir; solo une cuando el dueño confirma.
const pool = require('./db');

// Abreviaturas y variantes habituales en comercios argentinos (a la forma que se usa para comparar)
const EXPANDE = {
  alf: 'alfajor', alfa: 'alfajor', alfaj: 'alfajor', mna: 'maizena', maicena: 'maizena', maisena: 'maizena',
  galle: 'galletita', galleta: 'galletita', galletas: 'galletita', galletita: 'galletita', galletitas: 'galletita', gall: 'galletita',
  choc: 'chocolate', chocol: 'chocolate', ddl: 'dulce de leche', dl: 'dulce de leche', vain: 'vainilla', frut: 'frutilla',
  gas: 'gaseosa', gaseosas: 'gaseosa', agua: 'agua', min: 'mineral', s: '', c: 'con', cn: 'con', sab: 'sabor',
  yog: 'yogur', yogurt: 'yogur', yogurth: 'yogur', cerv: 'cerveza', cervezas: 'cerveza', fid: 'fideos', fideo: 'fideos',
  lech: 'leche', desc: 'descremada', semi: 'semidescremada', entera: 'entera', cafe: 'cafe', cafes: 'cafe',
  pan: 'pan', panes: 'pan', medialuna: 'medialuna', medialunas: 'medialuna', facturas: 'factura', sandwich: 'sandwich', sanguche: 'sandwich', sandwiches: 'sandwich',
};
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'y', 'e', 'en', 'x', 'u', 'un', 'una', 'por', 'p', 'a']);

function sinTildes(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

const RE_TAM = /^(\d+(?:[.,]\d+)?)(ml|cc|l|lt|lts|litro|litros|g|gr|grs|gramos|kg|kgs|kilo|kilos|u|un|unid|unidades|x)?$/;
// Devuelve un tamaño comparable ("500ml" -> {v:0.5,u:'l'}, "1,5lt" -> {v:1.5,u:'l'}, "2kg" -> {v:2000,u:'g'}) o null
function tamano(tok) {
  const m = RE_TAM.exec(tok);
  if (!m || !m[2]) return null;
  let v = Number(m[1].replace(',', '.')); const u = m[2];
  if (!(v > 0)) return null;
  if (['ml', 'cc'].includes(u)) return { v: v / 1000, u: 'l' };
  if (['l', 'lt', 'lts', 'litro', 'litros'].includes(u)) return { v, u: 'l' };
  if (['g', 'gr', 'grs', 'gramos'].includes(u)) return { v, u: 'g' };
  if (['kg', 'kgs', 'kilo', 'kilos'].includes(u)) return { v: v * 1000, u: 'g' };
  return { v, u: 'u' };
}

// Separa "500ml" o "1,5l" pegados al número ("coca1.5l") y "x6" en tokens
function tokenizar(texto) {
  const s = sinTildes(texto).replace(/(\d)([a-z])/g, '$1$2').replace(/[^a-z0-9.,\s]/g, ' ').replace(/(\d)[.,](?=\D|$)/g, '$1').replace(/\s+/g, ' ').trim();
  return s ? s.split(' ') : [];
}

function stem(t) {
  if (t.length > 4 && t.endsWith('es') && !EXPANDE[t]) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !EXPANDE[t]) return t.slice(0, -1);
  return t;
}

// -> { palabras: [...], tamanos: [{v,u}] } listo para comparar
function analizar(texto) {
  const palabras = [], tamanos = [];
  for (const t of tokenizar(texto)) {
    const tm = tamano(t);
    if (tm) { tamanos.push(tm); continue; }
    if (/^\d/.test(t) || VACIAS.has(t)) continue;
    const e = Object.prototype.hasOwnProperty.call(EXPANDE, t) ? EXPANDE[t] : stem(t);
    for (const w of String(e).split(' ')) if (w && !VACIAS.has(w)) palabras.push(w);
  }
  return { palabras: [...new Set(palabras)], tamanos };
}

// Distancia de Damerau-Levenshtein (las letras cambiadas de lugar, como aljafol/alfajor, cuentan poco)
function distancia(a, b) {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n) return m; if (!m) return n;
  const d = Array.from({ length: n + 1 }, (_, i) => [i, ...new Array(m).fill(0)]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[n][m];
}

// ¿Son la misma palabra, con tolerancia a errores de tipeo según el largo? (las palabras cortas casi no toleran nada)
function mismaPalabra(a, b) {
  if (a === b) return true;
  const L = Math.max(a.length, b.length);
  if (L <= 3) return false;
  if (a[0] !== b[0] && L <= 5) return false;          // "oreo" vs "ñoño": la primera letra ayuda en palabras cortas
  if (Math.abs(a.length - b.length) > 2) return false;   // "orio" no es "jorgito"
  const tol = L <= 5 ? 1 : L <= 6 ? 2 : 3;
  return distancia(a, b) <= tol;
}

function mismosTamanos(a, b) {
  if (a.length !== b.length) return false;
  const rest = b.slice();
  for (const x of a) { const i = rest.findIndex((y) => y.u === x.u && Math.abs(y.v - x.v) < 1e-9); if (i < 0) return false; rest.splice(i, 1); }
  return true;
}

// Parecido entre dos nombres de producto, de 0 a 1. 0 si los tamaños no coinciden.
function similitud(a, b) {
  const A = analizar(a), B = analizar(b);
  if (!A.palabras.length || !B.palabras.length) return 0;
  if (A.tamanos.length && B.tamanos.length && !mismosTamanos(A.tamanos, B.tamanos)) return 0;
  const libres = B.palabras.slice(); let m = 0;
  for (const w of A.palabras) { const i = libres.findIndex((x) => mismaPalabra(w, x)); if (i >= 0) { m++; libres.splice(i, 1); } }
  let s = m / Math.max(A.palabras.length, B.palabras.length);
  if (!!A.tamanos.length !== !!B.tamanos.length) s *= 0.9;   // uno dice el tamaño y el otro no: parecido pero menos seguro
  return Math.round(s * 100) / 100;
}

// Marca reconocida dentro del texto ("galleta orio" -> "Oreo") a partir de las marcas conocidas del negocio
function reconocerMarca(texto, marcas) {
  const toks = tokenizar(texto).filter((t) => !tamano(t) && !/^\d/.test(t));
  let mejor = null;
  for (const marca of marcas || []) {
    const mt = tokenizar(marca).filter((t) => t.length >= 3);
    if (!mt.length) continue;
    if (mt.every((x) => toks.some((t) => mismaPalabra(t, x)))) {
      const largo = mt.join('').length;
      if (!mejor || largo > mejor.largo) mejor = { marca, largo };
    }
  }
  return mejor ? mejor.marca : null;
}

// ── Base de datos ────────────────────────────────────────────────────────────
let listo = null;
function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS producto_alias (
        id SERIAL PRIMARY KEY, negocio_id INTEGER NOT NULL, alias TEXT NOT NULL, producto_id INTEGER NOT NULL, creado_en TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (negocio_id, alias))`);
      await db.query(`CREATE TABLE IF NOT EXISTS producto_codigos (
        id SERIAL PRIMARY KEY, negocio_id INTEGER NOT NULL, codigo TEXT NOT NULL, producto_id INTEGER NOT NULL, UNIQUE (negocio_id, codigo))`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

async function catalogo(negocioId, db) {
  return (await db.query(
    `SELECT id, nombre, marca, codigo_barras, precio_venta::float AS precio FROM productos WHERE negocio_id = $1 AND COALESCE(activo, true) = true`, [negocioId])).rows;
}

async function marcasConocidas(negocioId, db = pool) {
  const r = await db.query(`SELECT marca, COUNT(*)::int AS n FROM productos WHERE negocio_id = $1 AND COALESCE(activo, true) AND marca IS NOT NULL AND marca <> '' GROUP BY marca ORDER BY n DESC, marca`, [negocioId]);
  return r.rows.map((x) => x.marca);
}

// Productos que ya existen y parecen el mismo que el nombre que se está por cargar (primero los que ya fueron unificados con ese nombre)
async function buscarParecidos(negocioId, nombre, db = pool, { minimo = 0.67, limite = 3 } = {}) {
  await asegurar(db);
  const alias = (await db.query('SELECT p.id, p.nombre, p.marca, p.codigo_barras FROM producto_alias a JOIN productos p ON p.id = a.producto_id WHERE a.negocio_id = $1 AND a.alias = $2 AND COALESCE(p.activo, true)', [negocioId, analizar(nombre).palabras.join(' ')])).rows;
  const filas = await catalogo(negocioId, db);
  const marcas = await marcasConocidas(negocioId, db);
  const lista = filas.map((p) => ({ id: p.id, nombre: p.nombre, marca: p.marca, codigo_barras: p.codigo_barras, similitud: similitud(nombre, p.nombre) }))
    .filter((p) => p.similitud >= minimo).sort((x, y) => y.similitud - x.similitud).slice(0, limite);
  const ids = new Set(lista.map((p) => p.id));
  for (const p of alias) if (!ids.has(p.id)) lista.unshift({ ...p, similitud: 1, por_alias: true });
  return { parecidos: lista.slice(0, limite), marca_sugerida: reconocerMarca(nombre, marcas) };
}

// Grupos de productos del catálogo que parecen ser el mismo (para que el dueño confirme la unión)
async function sugerirUnificaciones(negocioId, db = pool, { minimo = 0.85 } = {}) {
  await asegurar(db);
  const filas = await catalogo(negocioId, db);
  const ventas = new Map((await db.query(`SELECT d.producto_id AS id, SUM(d.cantidad)::float AS u FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id WHERE t.negocio_id = $1 GROUP BY 1`, [negocioId]).catch(() => ({ rows: [] }))).rows.map((x) => [x.id, x.u]));
  const padre = new Map(filas.map((p) => [p.id, p.id]));
  const raiz = (x) => { while (padre.get(x) !== x) { padre.set(x, padre.get(padre.get(x))); x = padre.get(x); } return x; };
  for (let i = 0; i < filas.length; i++) for (let j = i + 1; j < filas.length; j++) {
    if (filas[i].codigo_barras && filas[j].codigo_barras && filas[i].codigo_barras === filas[j].codigo_barras) continue;
    if (similitud(filas[i].nombre, filas[j].nombre) >= minimo) padre.set(raiz(filas[j].id), raiz(filas[i].id));
  }
  const grupos = new Map();
  for (const p of filas) { const r = raiz(p.id); if (!grupos.has(r)) grupos.set(r, []); grupos.get(r).push({ ...p, unidades_vendidas: ventas.get(p.id) || 0 }); }
  return [...grupos.values()].filter((g) => g.length > 1).map((g) => {
    // El que queda: el que tiene código de barras, y si no, el más vendido
    const orden = g.slice().sort((a, b) => (!!b.codigo_barras - !!a.codigo_barras) || (b.unidades_vendidas - a.unidades_vendidas) || (a.nombre.length - b.nombre.length));
    return { sugerido_id: orden[0].id, productos: orden };
  }).sort((a, b) => b.productos.length - a.productos.length).slice(0, 30);
}

// Une productos: las ventas y las compras pasan al que queda, los demás se desactivan y se recuerdan sus nombres y códigos de barras.
async function unificar(negocioId, canonicoId, ids, db = pool) {
  await asegurar(db);
  const otros = [...new Set((ids || []).map(Number).filter((x) => Number.isInteger(x) && x !== Number(canonicoId)))];
  if (!otros.length) throw Object.assign(new Error('Elegí al menos otro producto para unir'), { status: 400 });
  const cx = db.connect ? await db.connect() : db;
  try {
    await cx.query('BEGIN');
    const ok = (await cx.query('SELECT id, nombre, marca, codigo_barras FROM productos WHERE negocio_id = $1 AND id = ANY($2::int[]) FOR UPDATE', [negocioId, [Number(canonicoId), ...otros]])).rows;
    const can = ok.find((p) => p.id === Number(canonicoId));
    if (!can || ok.length !== otros.length + 1) throw Object.assign(new Error('Algún producto no existe en tu negocio'), { status: 404 });
    for (const [tabla, col] of [['transacciones_detalle', 'producto_id'], ['carrito_items', 'producto_id'], ['compras_items', 'producto_id']]) {
      if ((await cx.query('SELECT to_regclass($1) AS t', [tabla])).rows[0].t) await cx.query(`UPDATE ${tabla} SET ${col} = $1 WHERE ${col} = ANY($2::int[])`, [can.id, otros]);
    }
    let adopta = can.codigo_barras || null, marca = can.marca || null;
    for (const p of ok.filter((x) => x.id !== can.id)) {
      const al = analizar(p.nombre).palabras.join(' ');
      if (al) await cx.query('INSERT INTO producto_alias (negocio_id, alias, producto_id) VALUES ($1,$2,$3) ON CONFLICT (negocio_id, alias) DO UPDATE SET producto_id = EXCLUDED.producto_id', [negocioId, al, can.id]);
      if (p.codigo_barras) {
        await cx.query('INSERT INTO producto_codigos (negocio_id, codigo, producto_id) VALUES ($1,$2,$3) ON CONFLICT (negocio_id, codigo) DO UPDATE SET producto_id = EXCLUDED.producto_id', [negocioId, p.codigo_barras, can.id]);
        if (!adopta) adopta = p.codigo_barras;
      }
      if (!marca && p.marca) marca = p.marca;
    }
    await cx.query('UPDATE productos SET activo = false, codigo_barras = NULL, updated_at = NOW() WHERE negocio_id = $1 AND id = ANY($2::int[])', [negocioId, otros]);
    await cx.query('UPDATE productos SET marca = COALESCE(marca, $3), codigo_barras = COALESCE(codigo_barras, $4), updated_at = NOW() WHERE negocio_id = $1 AND id = $2', [negocioId, can.id, marca, adopta]);
    await cx.query('COMMIT');
    return { ok: true, queda: can.id, unidos: otros.length };
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { if (cx !== db && cx.release) cx.release(); }
}

module.exports = { analizar, similitud, distancia, mismaPalabra, reconocerMarca, tamano, buscarParecidos, sugerirUnificaciones, unificar, marcasConocidas, asegurar };
