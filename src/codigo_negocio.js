// codigo_negocio.js — LumoBi · código de acceso del negocio para el Modo empleado (29/10/2026)
//
// Antes, la compu del local se identificaba con el número de negocio (13, 14, 15…):
// cualquiera podía probar números y ver los locales y empleados de otros negocios.
// Ahora cada negocio tiene un código aleatorio de 8 caracteres (ej. K7QM-2XPA), sin
// caracteres que se confundan, que el dueño ve y regenera en Ajustes.

const crypto = require('crypto');
const pool = require('./db');

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin O/0, I/1, L
const LARGO = 8;

function normalizarCodigo(c) {
  return String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatearCodigo(c) {
  const n = normalizarCodigo(c);
  return n.length === LARGO ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
}

function generarCodigo() {
  const bytes = crypto.randomBytes(LARGO);
  let s = '';
  for (let i = 0; i < LARGO; i++) s += ALFABETO[bytes[i] % ALFABETO.length];
  return s;
}

// Devuelve el negocio_id del código, o null. Nunca tira error.
async function negocioPorCodigo(codigo) {
  try {
    const c = normalizarCodigo(codigo);
    if (c.length !== LARGO) return null;
    const r = await pool.query('SELECT id FROM negocios WHERE codigo_acceso=$1', [c]);
    return r.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function asignarCodigoNuevo(negocioId) {
  for (let intento = 0; intento < 5; intento++) {
    const c = generarCodigo();
    try {
      await pool.query('UPDATE negocios SET codigo_acceso=$1 WHERE id=$2', [c, negocioId]);
      return c;
    } catch (e) {
      if (e.code !== '23505') throw e; // 23505 = choque con otro código: se reintenta
    }
  }
  throw new Error('No se pudo generar un código único');
}

async function obtenerOCrearCodigo(negocioId) {
  const r = await pool.query('SELECT codigo_acceso FROM negocios WHERE id=$1', [negocioId]);
  if (!r.rows.length) throw new Error('Negocio no encontrado');
  return r.rows[0].codigo_acceso || asignarCodigoNuevo(negocioId);
}

module.exports = { normalizarCodigo, formatearCodigo, negocioPorCodigo, obtenerOCrearCodigo, asignarCodigoNuevo };
