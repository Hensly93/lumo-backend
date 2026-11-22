// routes_partners.js — LumoBi Partners (la lógica está en partners.js).
//
// Público:
//   GET  /api/partners/codigo/:codigo    ¿el código existe? devuelve solo el primer nombre (para "Te recomendó Juan")
//   GET  /api/partners/reglas            cuánto se gana (para la página de partners y la calculadora)
//   POST /api/partners/registro          alta de partner { nombre, email, password, celular, zona, ref?, acepto }
//   POST /api/partners/login             { email, password }
// Partner (token propio, header Authorization: Bearer):
//   GET   /api/partners/yo               panel completo
//   PATCH /api/partners/yo               datos de cobro { cuit, alias_cbu, titular }, celular/zona y { formacion: true } al terminar la formación
//   GET   /api/partners/material         mensajes listos para mandar, con su link
// Admin (cuenta de LumoBi cuyo mail está en ADMIN_EMAILS):
//   GET  /api/partners/admin/lista
//   POST /api/partners/admin/:id/estado          { estado: 'activo' | 'suspendido' }
//   POST /api/partners/admin/asignar             { negocio_id, codigo }  (solo negocios registrados hace 7 días o menos y sin partner)
//   POST /api/partners/admin/:id/liquidar        junta todo lo disponible en una liquidación
//   POST /api/partners/admin/liquidacion/:id/pagada  { nota? }
//   POST /api/partners/admin/comision/:id/anular { nota }
//
// El token de partner se firma con otra clave: no sirve para entrar a ningún negocio, y el de un negocio no sirve acá.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const pool = require('./db');
const P = require('./partners');
const { limitar } = require('./rate_limit');
const { FRONTEND_URL } = require('./frontend_url');

const MIN = 60000, HORA = 60 * MIN;
const ip = (req) => req.ip || null;
const mail = (req) => { const e = req.body && req.body.email; return typeof e === 'string' && e ? e.trim().toLowerCase().slice(0, 200) : null; };
const frenoRegistro = limitar([{ nombre: 'partner_reg_ip', max: 8, ventanaMs: HORA, clave: ip }]);
const frenoLogin = limitar([{ nombre: 'partner_login_ip', max: 30, ventanaMs: 15 * MIN, clave: ip }, { nombre: 'partner_login_mail', max: 10, ventanaMs: 15 * MIN, clave: mail }]);
const frenoCodigo = limitar([{ nombre: 'partner_cod_ip', max: 60, ventanaMs: 15 * MIN, clave: ip }]);

function secreto() {
  if (!process.env.JWT_SECRET) throw new Error('Falta JWT_SECRET');
  return crypto.createHash('sha256').update(process.env.JWT_SECRET + '|lumobi-partners').digest('hex');
}
const huella = (hash) => crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 16);
function firmar(p) { return jwt.sign({ pid: p.id, tipo: 'partner', pv: huella(p.password) }, secreto(), { expiresIn: '30d' }); }

async function authPartner(req, res, next) {
  try {
    const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const d = jwt.verify(t, secreto());
    if (!d || d.tipo !== 'partner' || !d.pid) throw new Error('tipo');
    await P.asegurar();
    const r = await pool.query('SELECT id, password, estado FROM partners WHERE id=$1', [d.pid]);
    const p = r.rows[0];
    if (!p || huella(p.password) !== d.pv) return res.status(401).json({ error: 'Sesión vencida. Volvé a ingresar.' });
    if (p.estado === 'suspendido') return res.status(403).json({ error: 'Tu cuenta de partner está suspendida. Escribinos a hola@lumobi.com.ar.' });
    req.partner = { id: p.id };
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sesión vencida. Volvé a ingresar.' });
  }
}

async function authAdmin(req, res, next) {
  try {
    const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const admins = String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const d = jwt.verify(t, process.env.JWT_SECRET);
    if (!admins.length || !d || !d.id || d.purpose) throw new Error('no');
    const r = await pool.query('SELECT email FROM usuarios WHERE id=$1', [d.id]);
    const em = String((r.rows[0] && r.rows[0].email) || '').trim().toLowerCase();
    if (!em || !admins.includes(em)) throw new Error('no');
    await P.asegurar();
    next();
  } catch (e) {
    res.status(403).json({ error: 'Solo para el equipo de LumoBi.' });
  }
}

const primerNombre = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const emailOk = (e) => typeof e === 'string' && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const linkDe = (codigo) => `${FRONTEND_URL}/p/${encodeURIComponent(codigo)}`;

// ─── Público ─────────────────────────────────────────────────────────────────
router.get('/codigo/:codigo', frenoCodigo, async (req, res) => {
  try {
    const p = await P.porCodigo(req.params.codigo);
    if (!p || p.estado !== 'activo') return res.status(404).json({ valido: false });
    res.json({ valido: true, nombre: primerNombre(p.nombre) });
  } catch (e) { res.status(500).json({ valido: false }); }
});

router.get('/reglas', (req, res) => {
  res.json(P.reglasPublicas());
});

router.post('/registro', frenoRegistro, async (req, res) => {
  try {
    await P.asegurar();
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim().slice(0, 80);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const celular = String(b.celular || '').replace(/[^0-9+ ()-]/g, '').slice(0, 20);
    const zona = String(b.zona || '').trim().slice(0, 80) || null;
    if (nombre.length < 2) return res.status(400).json({ error: 'Escribí tu nombre y apellido.' });
    if (!emailOk(email)) return res.status(400).json({ error: 'Revisá el email.' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña tiene que tener 8 caracteres como mínimo.' });
    if (celular.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'Dejanos tu celular con WhatsApp: es por donde te ayudamos a cerrar tus primeros negocios.' });
    if (!b.acepto) return res.status(400).json({ error: 'Tenés que aceptar las condiciones del programa.' });
    const ya = await pool.query('SELECT 1 FROM partners WHERE LOWER(email)=$1', [email]);
    if (ya.rows.length) return res.status(400).json({ error: 'Ese email ya es partner. Tocá "Ingresar".' });
    let referidoPor = null;
    if (b.ref) {
      const r = await P.porCodigo(b.ref);
      if (r && r.estado === 'activo') referidoPor = r.id;
    }
    const codigo = await P.nuevoCodigo(nombre);
    const hash = await bcrypt.hash(password, 10);
    const ins = await pool.query(
      `INSERT INTO partners(nombre, email, password, celular, zona, codigo, referido_por, acepto_terminos)
       VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id, password, codigo, nombre`,
      [nombre, email, hash, celular, zona, codigo, referidoPor]);
    const p = ins.rows[0];
    require('./mailer').enviarPartner({
      email, nombre,
      titulo: `Bienvenido a LumoBi Partners, ${primerNombre(nombre)}`,
      url: `${FRONTEND_URL}/partners/formacion`, boton: 'Hacer la formación (5 minutos)',
      mensaje: `Tu link es ${linkDe(codigo)} y tu código es ${codigo}. Todo negocio que se registre con ese link queda en tu cartera. Antes de arrancar, hacé la formación: son 5 lecciones cortas y te explican todo.`,
    }).catch(() => {});
    try {
      require('./aviso_fundador').avisarFundador({ tipo: 'fundador_partner_nuevo', clave: 'partner_' + p.id, negocioId: null,
        titulo: `Nuevo partner: ${nombre}`, mensaje: `${zona ? zona + ' · ' : ''}${celular}${referidoPor ? ' · lo trajo otro partner' : ''}` }).catch(() => {});
    } catch (e) { /* sin aviso */ }
    res.json({ token: firmar(p), codigo: p.codigo, nombre: p.nombre });
  } catch (e) {
    console.error('[PARTNERS] registro:', e.message);
    res.status(500).json({ error: 'No se pudo crear tu cuenta. Probá de nuevo.' });
  }
});

router.post('/login', frenoLogin, async (req, res) => {
  try {
    await P.asegurar();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const r = await pool.query('SELECT id, password, nombre, codigo, estado FROM partners WHERE LOWER(email)=$1', [email]);
    const p = r.rows[0];
    const ok = p && await bcrypt.compare(String((req.body && req.body.password) || ''), p.password);
    if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    if (p.estado === 'suspendido') return res.status(403).json({ error: 'Tu cuenta de partner está suspendida. Escribinos a hola@lumobi.com.ar.' });
    await pool.query('UPDATE partners SET ultimo_ingreso=NOW() WHERE id=$1', [p.id]);
    res.json({ token: firmar(p), codigo: p.codigo, nombre: p.nombre });
  } catch (e) {
    console.error('[PARTNERS] login:', e.message);
    res.status(500).json({ error: 'No se pudo ingresar. Probá de nuevo.' });
  }
});

// ─── Partner ─────────────────────────────────────────────────────────────────
router.get('/yo', authPartner, async (req, res) => {
  try {
    const d = await P.panel(req.partner.id);
    if (!d) return res.status(404).json({ error: 'No encontrado' });
    d.partner.link = linkDe(d.partner.codigo);
    d.partner.link_partners = `${FRONTEND_URL}/partners?ref=${encodeURIComponent(d.partner.codigo)}`;
    pool.query('UPDATE partners SET ultimo_ingreso=NOW() WHERE id=$1', [req.partner.id]).catch(() => {});
    res.json(d);
  } catch (e) {
    console.error('[PARTNERS] panel:', e.message);
    res.status(500).json({ error: 'No se pudo cargar tu panel.' });
  }
});

router.patch('/yo', authPartner, async (req, res) => {
  try {
    const b = req.body || {};
    const cuit = b.cuit != null ? String(b.cuit).replace(/\D/g, '') : undefined;
    if (cuit !== undefined && cuit && cuit.length !== 11) return res.status(400).json({ error: 'El CUIT/CUIL tiene que tener 11 números.' });
    const alias = b.alias_cbu != null ? String(b.alias_cbu).trim().slice(0, 40) : undefined;
    if (alias !== undefined && alias && !(/^\d{22}$/.test(alias) || /^[a-zA-Z0-9.-]{6,20}$/.test(alias))) {
      return res.status(400).json({ error: 'Poné un alias (6 a 20 letras, números, puntos o guiones) o un CBU/CVU de 22 números.' });
    }
    const titular = b.titular != null ? String(b.titular).trim().slice(0, 80) : undefined;
    const celular = b.celular != null ? String(b.celular).replace(/[^0-9+ ()-]/g, '').slice(0, 20) : undefined;
    const zona = b.zona != null ? String(b.zona).trim().slice(0, 80) : undefined;
    if (b.formacion === true) await pool.query('UPDATE partners SET formacion_completa=COALESCE(formacion_completa, NOW()) WHERE id=$1', [req.partner.id]);
    await pool.query(
      `UPDATE partners SET cuit=COALESCE($2, cuit), alias_cbu=COALESCE($3, alias_cbu), titular=COALESCE($4, titular),
              celular=COALESCE($5, celular), zona=COALESCE($6, zona) WHERE id=$1`,
      [req.partner.id, cuit === undefined ? null : cuit, alias === undefined ? null : alias, titular === undefined ? null : titular,
        celular === undefined ? null : celular, zona === undefined ? null : zona]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo guardar.' });
  }
});

router.get('/material', authPartner, async (req, res) => {
  try {
    const r = await pool.query('SELECT nombre, codigo FROM partners WHERE id=$1', [req.partner.id]);
    const p = r.rows[0];
    const link = linkDe(p.codigo);
    const yo = primerNombre(p.nombre);
    res.json({
      link, codigo: p.codigo,
      mensajes: [
        { titulo: 'Primer contacto (alguien que conocés)',
          texto: `Hola! ¿Cómo andás? Te escribo porque estoy trabajando con LumoBi, un sistema para comercios que te avisa dónde se te va la plata: diferencias de caja, productos que vendés por debajo del costo, horarios flojos. Tiene 5 días de prueba gratis y no pide tarjeta. ¿Te paso el link para que lo veas? ${link}` },
        { titulo: 'Corto, para mandar a un comercio',
          texto: `Hola, soy ${yo}. ¿Sabés cuánta plata se te pierde por mes en la caja o en productos mal cobrados? LumoBi lo mide y te avisa. Probalo 5 días gratis, sin tarjeta: ${link}` },
        { titulo: 'Para el que tiene empleados o más de un local',
          texto: `Si no podés estar en el local todo el día, LumoBi te muestra cada turno: cuánto se vendió, si cerró la caja y si algo no cuadra, sin acusar a nadie. Lo podés probar 5 días gratis: ${link}` },
        { titulo: 'Seguimiento (a los 2 días)',
          texto: `Hola! ¿Pudiste probar LumoBi? Si querés lo dejamos andando juntos en 10 minutos: cargamos tus productos y hacés la primera venta. ¿Te viene bien hoy o mañana?` },
        { titulo: '"Ya tengo un sistema"',
          texto: `Está perfecto. La mayoría de los sistemas te dicen cuánto vendiste; LumoBi te dice dónde se te va la plata y por qué. Probalo 5 días y comparalo: si no te muestra nada nuevo, no lo usás y listo.` },
        { titulo: '"Es caro"',
          texto: `El abono arranca en $45.000 por mes. Lo que buscamos es que LumoBi te encuentre más plata de la que cuesta: con una diferencia de caja por semana que detecte, ya se paga. Por eso tenés 5 días gratis para comprobarlo con tus números.` },
      ],
      consejos: [
        'Empezá por los comercios que ya conocés: el dueño te atiende y confía.',
        'La comisión se genera cuando el negocio paga, no cuando se registra. Lo que más ayuda es que haga su primera venta y cierre su primer turno de caja durante la prueba.',
        'No prometas montos de ahorro: LumoBi muestra lo que encuentra en cada negocio, y cada negocio es distinto.',
        'Si un negocio se registra sin tu link, no queda en tu cartera. Mandale siempre tu link.',
      ],
    });
  } catch (e) { res.status(500).json({ error: 'No se pudo cargar el material.' }); }
});

// ─── Admin ───────────────────────────────────────────────────────────────────
router.get('/admin/lista', authAdmin, async (req, res) => {
  try {
    await P.liberarPendientes().catch(() => {});
    const r = await pool.query(
      `SELECT p.id, p.nombre, p.email, p.celular, p.zona, p.codigo, p.estado, p.creado, p.ultimo_ingreso,
              p.cuit, p.alias_cbu, p.titular, p.formacion_completa, r.nombre AS referido_por,
              (SELECT COUNT(*)::int FROM partner_clientes pc WHERE pc.partner_id=p.id) AS clientes,
              (SELECT COUNT(*)::int FROM partner_clientes pc WHERE pc.partner_id=p.id AND pc.primer_pago IS NOT NULL) AS pagaron,
              COALESCE((SELECT SUM(monto) FROM partner_comisiones k WHERE k.partner_id=p.id AND k.estado='pendiente'),0)::float AS pendiente,
              COALESCE((SELECT SUM(monto) FROM partner_comisiones k WHERE k.partner_id=p.id AND k.estado='disponible'),0)::float AS disponible,
              COALESCE((SELECT SUM(monto) FROM partner_comisiones k WHERE k.partner_id=p.id AND k.estado='liquidada'),0)::float AS pagado
         FROM partners p LEFT JOIN partners r ON r.id = p.referido_por ORDER BY p.creado DESC`);
    const liq = await pool.query(
      `SELECT l.id, l.partner_id, p.nombre, l.total::float, l.alias_cbu, l.estado, l.creado, l.pagada_en
         FROM partner_liquidaciones l JOIN partners p ON p.id = l.partner_id ORDER BY l.creado DESC LIMIT 50`);
    const sinPartner = await pool.query(
      `SELECT n.id, n.nombre, n.created_at FROM negocios n
        WHERE n.created_at >= NOW() - INTERVAL '7 days' AND NOT EXISTS (SELECT 1 FROM partner_clientes pc WHERE pc.negocio_id = n.id)
        ORDER BY n.created_at DESC LIMIT 50`).catch(() => ({ rows: [] }));
    res.json({ partners: r.rows, liquidaciones: liq.rows, negocios_sin_partner: sinPartner.rows, reglas: P.reglas() });
  } catch (e) {
    console.error('[PARTNERS] admin lista:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/:id/estado', authAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const estado = req.body && req.body.estado;
  if (!id || !['activo', 'suspendido'].includes(estado)) return res.status(400).json({ error: 'Estado no válido' });
  await pool.query('UPDATE partners SET estado=$2 WHERE id=$1', [id, estado]);
  res.json({ ok: true });
});

router.post('/admin/asignar', authAdmin, async (req, res) => {
  try {
    const nid = parseInt(req.body && req.body.negocio_id, 10);
    const p = await P.porCodigo(req.body && req.body.codigo);
    if (!nid || !p) return res.status(400).json({ error: 'Negocio o código no válido' });
    const n = await pool.query("SELECT id FROM negocios WHERE id=$1 AND created_at >= NOW() - INTERVAL '7 days'", [nid]);
    if (!n.rows.length) return res.status(400).json({ error: 'Solo se pueden asignar negocios registrados en los últimos 7 días.' });
    const ins = await pool.query("INSERT INTO partner_clientes(negocio_id, partner_id, origen) VALUES($1,$2,'admin') ON CONFLICT (negocio_id) DO NOTHING RETURNING negocio_id", [nid, p.id]);
    if (!ins.rows.length) return res.status(409).json({ error: 'Ese negocio ya tiene partner.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/:id/liquidar', authAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query('SELECT id, nombre, email, alias_cbu, cuit, titular FROM partners WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No encontrado' }); }
    if (!p.alias_cbu || !p.cuit) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El partner todavía no cargó su CUIT y su alias/CBU.' }); }
    const k = await client.query("SELECT id, monto FROM partner_comisiones WHERE partner_id=$1 AND estado='disponible' FOR UPDATE", [id]);
    const total = Math.round(k.rows.reduce((a, x) => a + Number(x.monto), 0) * 100) / 100;
    if (!(total > 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No tiene comisiones disponibles para liquidar.' }); }
    const l = await client.query('INSERT INTO partner_liquidaciones(partner_id, total, alias_cbu) VALUES($1,$2,$3) RETURNING id', [id, total, p.alias_cbu]);
    await client.query("UPDATE partner_comisiones SET estado='liquidada', liquidacion_id=$2 WHERE id = ANY($1::int[])", [k.rows.map((x) => x.id), l.rows[0].id]);
    await client.query('COMMIT');
    res.json({ ok: true, liquidacion_id: l.rows[0].id, total, alias_cbu: p.alias_cbu, cuit: p.cuit, titular: p.titular });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (x) { /* nada */ }
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.post('/admin/liquidacion/:id/pagada', authAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("UPDATE partner_liquidaciones SET estado='pagada', pagada_en=NOW(), nota=$2 WHERE id=$1 AND estado='pendiente' RETURNING partner_id, total", [id, String((req.body && req.body.nota) || '').slice(0, 200) || null]);
  if (!r.rows.length) return res.status(404).json({ error: 'No encontrada o ya pagada' });
  P.avisarPartner(r.rows[0].partner_id, { titulo: `Te transferimos ${P.pesos(r.rows[0].total)}`, mensaje: 'Es tu liquidación de comisiones de LumoBi Partners. Ya está en tu cuenta.' });
  res.json({ ok: true });
});

router.post('/admin/comision/:id/anular', authAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("UPDATE partner_comisiones SET estado='anulada', nota=$2 WHERE id=$1 AND estado IN ('pendiente','disponible') RETURNING id", [id, String((req.body && req.body.nota) || 'anulada').slice(0, 200)]);
  if (!r.rows.length) return res.status(404).json({ error: 'No encontrada o ya liquidada' });
  res.json({ ok: true });
});

module.exports = router;
