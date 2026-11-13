// rate_limit.js — freno de intentos para login, registro y recupero de clave (sin dependencias, en memoria).
// Cuenta pedidos por clave dentro de una ventana de tiempo; pasado el máximo responde 429 hasta que la ventana se vacía.
// Es por instancia del servidor: alcanza para frenar adivinadores de claves y registros en masa.
const golpes = new Map();   // clave -> [timestamps]

function permitir(clave, max, ventanaMs, ahora = Date.now()) {
  const desde = ahora - ventanaMs;
  const lista = (golpes.get(clave) || []).filter((t) => t > desde);
  if (lista.length >= max) { golpes.set(clave, lista); return { ok: false, espera: Math.max(1, Math.ceil((lista[0] + ventanaMs - ahora) / 1000)) }; }
  lista.push(ahora); golpes.set(clave, lista);
  return { ok: true, espera: 0 };
}

// reglas: [{ nombre, max, ventanaMs, clave: (req) => string|null }]
function limitar(reglas) {
  return (req, res, next) => {
    for (const r of reglas) {
      let k = null;
      try { k = r.clave(req); } catch (_) { k = null; }
      if (!k) continue;
      const v = permitir(r.nombre + ':' + k, r.max, r.ventanaMs);
      if (!v.ok) {
        res.set('Retry-After', String(v.espera));
        return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en ' + (v.espera >= 120 ? Math.ceil(v.espera / 60) + ' minutos' : 'un rato') + '.' });
      }
    }
    next();
  };
}

const ip = (req) => req.ip || (req.connection && req.connection.remoteAddress) || null;
const mail = (req) => { const e = req.body && req.body.email; return typeof e === 'string' && e ? e.trim().toLowerCase().slice(0, 200) : null; };
const MIN = 60 * 1000, HORA = 60 * MIN;

const frenoAuth = {
  login: limitar([
    { nombre: 'login_ip', max: 30, ventanaMs: 15 * MIN, clave: ip },
    { nombre: 'login_mail', max: 10, ventanaMs: 15 * MIN, clave: mail },
  ]),
  registro: limitar([{ nombre: 'registro_ip', max: 10, ventanaMs: HORA, clave: ip }]),
  olvido: limitar([
    { nombre: 'olvido_ip', max: 8, ventanaMs: HORA, clave: ip },
    { nombre: 'olvido_mail', max: 3, ventanaMs: HORA, clave: mail },
  ]),
  reset: limitar([{ nombre: 'reset_ip', max: 10, ventanaMs: HORA, clave: ip }]),
};

// Limpieza para que el mapa no crezca sin límite.
const t = setInterval(() => { const corte = Date.now() - 2 * HORA; for (const [k, l] of golpes) { if (!l.length || l[l.length - 1] < corte) golpes.delete(k); } }, 10 * MIN);
if (t.unref) t.unref();

module.exports = { permitir, limitar, frenoAuth };
