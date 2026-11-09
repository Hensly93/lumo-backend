// Prueba gratis: huella anti-reingreso y fechas de la prueba.
// La huella guarda SOLO hashes (HMAC) del email normalizado, del CUIT y del celular: no se pueden leer ni revertir,
// y quedan guardados aunque el negocio borre su cuenta, para que no pueda volver a pedir la prueba gratis.
const crypto = require('crypto');

const DIAS_PRUEBA = 5;

function secreto() { return process.env.HUELLA_SECRET || process.env.JWT_SECRET || 'lumobi-huella'; }
function hmac(tipo, valor) { return crypto.createHmac('sha256', secreto()).update(tipo + ':' + valor).digest('hex'); }

// Gmail ignora los puntos y lo que va despues del "+": juan.perez+x@gmail.com es juanperez@gmail.com
function normEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  const i = s.lastIndexOf('@');
  if (i < 1) return null;
  let u = s.slice(0, i), d = s.slice(i + 1);
  if (!d || d.indexOf('.') < 0) return null;
  if (d === 'googlemail.com') d = 'gmail.com';
  u = u.split('+')[0];
  if (d === 'gmail.com') u = u.replace(/\./g, '');
  return u ? u + '@' + d : null;
}
// Celular argentino: se comparan los ultimos 8 digitos (sin 0, sin 15, sin 54 ni 9), asi "011 15 5555-1234" y "+54 9 11 5555 1234" coinciden.
function normCelular(c) {
  const d = String(c || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}
function normCuit(c) {
  const d = String(c || '').replace(/\D/g, '');
  return d.length === 11 ? d : null;
}

function huellasDe(datos) {
  const out = [];
  const e = normEmail(datos && datos.email); if (e) out.push({ tipo: 'email', hash: hmac('email', e) });
  const t = normCuit(datos && datos.cuit); if (t) out.push({ tipo: 'cuit', hash: hmac('cuit', t) });
  const c = normCelular(datos && datos.celular); if (c) out.push({ tipo: 'celular', hash: hmac('celular', c) });
  return out;
}

// true si CUALQUIERA de los tres datos ya uso la prueba. Para probar sin que cuente: TRIAL_SIN_HUELLA=1 (solo pruebas).
async function yaUsoPrueba(db, datos) {
  if (process.env.TRIAL_SIN_HUELLA === '1') return false;
  const hs = huellasDe(datos);
  if (!hs.length) return false;
  const params = [];
  const conds = hs.map((h) => { params.push(h.tipo, h.hash); return '(tipo=$' + (params.length - 1) + ' AND hash=$' + params.length + ')'; });
  const r = await db.query('SELECT 1 FROM trial_huellas WHERE ' + conds.join(' OR ') + ' LIMIT 1', params);
  return r.rows.length > 0;
}

async function guardarHuella(db, datos) {
  for (const h of huellasDe(datos)) {
    await db.query('INSERT INTO trial_huellas(tipo, hash) VALUES($1,$2) ON CONFLICT (tipo, hash) DO NOTHING', [h.tipo, h.hash]);
  }
}

function finDePrueba(desde) {
  const d = desde ? new Date(desde) : new Date();
  return new Date(d.getTime() + DIAS_PRUEBA * 86400000);
}

module.exports = { DIAS_PRUEBA, normEmail, normCelular, normCuit, huellasDe, yaUsoPrueba, guardarHuella, finDePrueba };
