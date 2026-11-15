// caja_extra.js — lo que le faltaba a la caja para usarse de verdad (14/11/2026):
//   · "varios": algo sin código ni producto cargado, con precio a mano (pan suelto, una fotocopia)
//   · descuento: por % o en pesos sobre el total, con motivo; queda registrado y si es grande pide autorización
//   · pago mixto: parte en efectivo y el resto con otro medio (columna monto_efectivo en transacciones)
// Las líneas "varios" y "descuento" van en el carrito sin producto del catálogo (producto_id vacío),
// así no ensucian el catálogo ni el stock del dueño; en el detalle de la venta quedan con su descripción.
const pool = require('./db');

let listo = null;
function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await db.query(`ALTER TABLE carrito_items ALTER COLUMN producto_id DROP NOT NULL`);
      await db.query(`ALTER TABLE carrito_items ADD COLUMN IF NOT EXISTS descripcion TEXT`);
      await db.query(`ALTER TABLE carrito_items ADD COLUMN IF NOT EXISTS tipo_linea TEXT NOT NULL DEFAULT 'producto'`);
      await db.query(`ALTER TABLE transacciones_detalle ALTER COLUMN producto_id DROP NOT NULL`);
      await db.query(`ALTER TABLE transacciones_detalle ADD COLUMN IF NOT EXISTS tipo_linea TEXT NOT NULL DEFAULT 'producto'`);
      await db.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS monto_efectivo NUMERIC(14,2)`);
      await db.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS metodo_resto TEXT`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

const MEDIOS_RESTO = ['debito', 'credito', 'transferencia', 'qr', 'mp'];

async function agregarVarios(turnoId, { precio, descripcion }, db = pool) {
  await asegurar(db);
  const p = Math.round(Number(precio) * 100) / 100;
  if (!(p > 0) || p > 10000000) return { ok: false, error: 'Escribí un precio válido.' };
  const d = String(descripcion || '').trim().slice(0, 60) || 'Varios';
  const r = await db.query(
    `INSERT INTO carrito_items (turno_id, producto_id, cantidad, precio_unitario, agregado_por, descripcion, tipo_linea)
     VALUES ($1, NULL, 1, $2, 'caja', $3, 'varios') RETURNING id`, [turnoId, p, d]);
  return { ok: true, id: r.rows[0].id };
}

// Subtotal sin descuentos (para calcular el %)
async function subtotal(turnoId, db = pool) {
  const r = await db.query(
    `SELECT COALESCE(SUM(cantidad * precio_unitario),0)::float AS s FROM carrito_items WHERE turno_id = $1 AND tipo_linea <> 'descuento'`, [turnoId]);
  return r.rows[0].s;
}

function calcularDescuento(sub, { modo, valor }) {
  const v = Number(valor) || 0;
  if (!(v > 0) || !(sub > 0)) return null;
  const monto = modo === 'pct' ? Math.round(sub * Math.min(v, 100)) / 100 : Math.min(v, sub);
  const pct = sub > 0 ? (monto / sub) * 100 : 0;
  return { monto: Math.round(monto * 100) / 100, pct };
}

// Reemplaza el descuento del carrito (hay uno solo por venta)
async function ponerDescuento(turnoId, { monto, pct, motivo }, db = pool) {
  await asegurar(db);
  await db.query(`DELETE FROM carrito_items WHERE turno_id = $1 AND tipo_linea = 'descuento'`, [turnoId]);
  const texto = 'Descuento ' + (pct >= 1 ? Math.round(pct) + '%' : '$' + Math.round(monto).toLocaleString('es-AR')) + (motivo ? ' · ' + String(motivo).slice(0, 60) : '');
  await db.query(
    `INSERT INTO carrito_items (turno_id, producto_id, cantidad, precio_unitario, agregado_por, descripcion, tipo_linea)
     VALUES ($1, NULL, 1, $2, 'caja', $3, 'descuento')`, [turnoId, -monto, texto]);
  return { ok: true, descripcion: texto };
}

async function sacarDescuento(turnoId, db = pool) {
  await asegurar(db);
  await db.query(`DELETE FROM carrito_items WHERE turno_id = $1 AND tipo_linea = 'descuento'`, [turnoId]);
}

// Valida el pago mixto contra el total del carrito. Devuelve { ok, monto_efectivo, metodo_resto } o { ok:false, error }
async function validarMixto(turnoId, { monto_efectivo, metodo_resto }, db = pool) {
  const r = await db.query(`SELECT COALESCE(SUM(cantidad * precio_unitario),0)::float AS t FROM carrito_items WHERE turno_id = $1`, [turnoId]);
  const total = r.rows[0].t;
  const ef = Math.round(Number(monto_efectivo) * 100) / 100;
  if (!MEDIOS_RESTO.includes(String(metodo_resto))) return { ok: false, error: 'Elegí con qué paga el resto.' };
  if (!(ef > 0) || ef >= total) return { ok: false, error: 'La parte en efectivo tiene que ser menor que el total.' };
  return { ok: true, monto_efectivo: ef, metodo_resto: String(metodo_resto), total };
}

module.exports = { asegurar, agregarVarios, subtotal, calcularDescuento, ponerDescuento, sacarDescuento, validarMixto, MEDIOS_RESTO };
