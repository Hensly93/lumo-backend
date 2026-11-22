// partners.js — LumoBi Partners: personas que traen negocios a LumoBi y cobran por su cartera.
//
// Cómo gana un partner (igual para todos, como un productor de seguros). Montos FIJOS por comercio, no por local:
//   · Alta: PARTNER_ALTA_MONTO cuando un comercio que trajo paga su primer abono.
//   · Cartera: PARTNER_CARTERA_MONTO por cada abono siguiente, todos los meses, mientras el comercio siga pagando.
//   · Por partner invitado: PARTNER_BONO_POR_NEGOCIO por cada comercio que ese partner traiga y pague (una vez por comercio),
//     hasta PARTNER_BONO_TOPE comercios por partner invitado. Un solo nivel: no cobra nada de los que invite el invitado.
//   · Nivel Elite: con PARTNER_ELITE_CLIENTES comercios pagando, los comercios que empiecen a pagar DESDE ESE MOMENTO dejan
//     PARTNER_ELITE_CARTERA_MONTO por mes (la cartera vieja queda como estaba: el costo sube de a poco).
//
// Reglas:
//   · La comisión nace de un pago REAL aprobado por Mercado Pago. Registrarse o estar en prueba no genera nada.
//   · Es por comercio: tenga 1 local o 10, deja lo mismo. Si un comercio pagó menos que la comisión (un descuento), se paga lo que pagó sin IVA.
//   · Cada pago genera su comisión una sola vez (aunque el aviso llegue repetido).
//   · Queda "pendiente" PARTNER_RETENCION_DIAS días (por si el pago se cae) y después pasa a "disponible" para liquidar.
//   · El comercio se asigna al partner SOLO al registrarse con su link o código. Nadie puede reclamar un cliente que ya estaba.
//   · Un partner no puede traerse a sí mismo (mismo email, celular o CUIT).
//   · El partner ve de sus comercios el nombre, el estado del plan y si ya arrancó. Nunca ventas, montos ni datos de contacto.
//
// Montos ajustables desde Render (sin tocar código):
//   PARTNER_ALTA_MONTO (22500) · PARTNER_CARTERA_MONTO (10000) · PARTNER_ELITE_CLIENTES (30) · PARTNER_ELITE_CARTERA_MONTO (12000)
//   PARTNER_BONO_POR_NEGOCIO (6000) · PARTNER_BONO_TOPE (10) · PARTNER_RETENCION_DIAS (15) · PARTNER_IVA (0.21, el IVA incluido en el cobro)
//   PARTNER_PRECIO_BASE (45000, solo para mostrar)

const crypto = require('crypto');
const pool = require('./db');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== '' && v != null ? n : d; };
function reglas() {
  return {
    alta_monto: num(process.env.PARTNER_ALTA_MONTO, 22500),
    cartera_monto: num(process.env.PARTNER_CARTERA_MONTO, 10000),
    elite_clientes: num(process.env.PARTNER_ELITE_CLIENTES, 30),
    elite_cartera_monto: num(process.env.PARTNER_ELITE_CARTERA_MONTO, 12000),
    bono_por_negocio: num(process.env.PARTNER_BONO_POR_NEGOCIO, 6000),
    bono_tope: num(process.env.PARTNER_BONO_TOPE, 10),
    retencion_dias: num(process.env.PARTNER_RETENCION_DIAS, 15),
    iva: num(process.env.PARTNER_IVA, 0.21),
    precio_base: num(process.env.PARTNER_PRECIO_BASE, 45000),
  };
}
function reglasPublicas() {
  const R = reglas();
  return { alta_monto: R.alta_monto, cartera_monto: R.cartera_monto, elite_clientes: R.elite_clientes, elite_cartera_monto: R.elite_cartera_monto,
    bono_por_negocio: R.bono_por_negocio, bono_tope: R.bono_tope, retencion_dias: R.retencion_dias, precio_base: R.precio_base };
}

let listo = null;
function asegurar() {
  if (!listo) {
    listo = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS partners(
        id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, email TEXT NOT NULL, password TEXT NOT NULL,
        celular TEXT, zona TEXT, codigo TEXT NOT NULL, referido_por INTEGER REFERENCES partners(id),
        estado TEXT NOT NULL DEFAULT 'activo', cuit TEXT, alias_cbu TEXT, titular TEXT,
        acepto_terminos TIMESTAMPTZ, creado TIMESTAMPTZ DEFAULT NOW(), ultimo_ingreso TIMESTAMPTZ)`);
      await pool.query('ALTER TABLE partners ADD COLUMN IF NOT EXISTS formacion_completa TIMESTAMPTZ');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_email ON partners(LOWER(email))');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_codigo ON partners(codigo)');
      await pool.query(`CREATE TABLE IF NOT EXISTS partner_clientes(
        negocio_id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL REFERENCES partners(id),
        origen TEXT NOT NULL DEFAULT 'link', cartera_pct NUMERIC(5,4), primer_pago TIMESTAMPTZ, creado TIMESTAMPTZ DEFAULT NOW())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_partner_clientes_p ON partner_clientes(partner_id)');
      await pool.query('ALTER TABLE partner_clientes ADD COLUMN IF NOT EXISTS cartera_monto NUMERIC(14,2)');
      await pool.query(`CREATE TABLE IF NOT EXISTS partner_liquidaciones(
        id SERIAL PRIMARY KEY, partner_id INTEGER NOT NULL REFERENCES partners(id), total NUMERIC(14,2) NOT NULL,
        alias_cbu TEXT, estado TEXT NOT NULL DEFAULT 'pendiente', nota TEXT, creado TIMESTAMPTZ DEFAULT NOW(), pagada_en TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS partner_comisiones(
        id SERIAL PRIMARY KEY, partner_id INTEGER NOT NULL REFERENCES partners(id), negocio_id INTEGER,
        referido_id INTEGER, tipo TEXT NOT NULL, origen TEXT NOT NULL, base NUMERIC(14,2), pct NUMERIC(5,4),
        monto NUMERIC(14,2) NOT NULL, estado TEXT NOT NULL DEFAULT 'pendiente', liquidacion_id INTEGER REFERENCES partner_liquidaciones(id),
        nota TEXT, creado TIMESTAMPTZ DEFAULT NOW())`);
      // "origen" hace única cada comisión: el id del pago de Mercado Pago, o "bono:<partner referido>"
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_com_origen ON partner_comisiones(partner_id, tipo, origen)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_partner_com_p ON partner_comisiones(partner_id, estado)');
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

// ─── Códigos ─────────────────────────────────────────────────────────────────
const SIN_CONFUSION = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sin 0/O ni 1/I/L
function normCodigo(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || null; }
async function nuevoCodigo(nombre) {
  const base = String(nombre || 'LUMO').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'LUMO';
  for (let i = 0; i < 20; i++) {
    let s = '';
    const b = crypto.randomBytes(4);
    for (let j = 0; j < 4; j++) s += SIN_CONFUSION[b[j] % SIN_CONFUSION.length];
    const c = base + s;
    const ya = await pool.query('SELECT 1 FROM partners WHERE codigo=$1', [c]);
    if (!ya.rows.length) return c;
  }
  throw new Error('No se pudo generar un código');
}

async function porCodigo(codigo, db = pool) {
  await asegurar();
  const c = normCodigo(codigo);
  if (!c) return null;
  const r = await db.query("SELECT id, nombre, email, celular, estado FROM partners WHERE codigo=$1", [c]);
  return r.rows[0] || null;
}

const soloDigitos = (s) => String(s || '').replace(/\D/g, '');
const mismoCel = (a, b) => { const x = soloDigitos(a).slice(-8), y = soloDigitos(b).slice(-8); return x.length === 8 && x === y; };

// ─── Asignar un negocio nuevo a un partner (al registrarse con su link) ───────────────────
// Nunca rompe el registro: si algo falla, el negocio queda sin partner y se puede asignar desde /admin.
async function atribuir({ negocioId, codigo, email, celular, cuit, origen }) {
  try {
    await asegurar();
    const p = await porCodigo(codigo);
    if (!p || p.estado !== 'activo') return { ok: false, motivo: 'codigo' };
    const { normEmail } = require('./trial');
    if (normEmail(p.email) && normEmail(p.email) === normEmail(email)) return { ok: false, motivo: 'propio' };
    if (celular && p.celular && mismoCel(celular, p.celular)) return { ok: false, motivo: 'propio' };
    if (cuit) {
      const pc = await pool.query('SELECT cuit FROM partners WHERE id=$1', [p.id]);
      if (pc.rows[0] && pc.rows[0].cuit && soloDigitos(pc.rows[0].cuit) === soloDigitos(cuit)) return { ok: false, motivo: 'propio' };
    }
    const ins = await pool.query(
      "INSERT INTO partner_clientes(negocio_id, partner_id, origen) VALUES($1,$2,$3) ON CONFLICT (negocio_id) DO NOTHING RETURNING negocio_id",
      [negocioId, p.id, origen || 'link']);
    if (ins.rows.length) {
      const n = await pool.query('SELECT nombre FROM negocios WHERE id=$1', [negocioId]);
      avisarPartner(p.id, {
        titulo: `${(n.rows[0] && n.rows[0].nombre) || 'Un negocio'} se registró con tu link`,
        mensaje: 'Ya está en su prueba gratis de 5 días. Si lo ayudás a hacer su primera venta y cerrar su primer turno de caja, es mucho más probable que se quede. La comisión se genera cuando paga su primer abono.',
      });
    }
    return { ok: !!ins.rows.length, partner_id: p.id };
  } catch (e) {
    console.error('[PARTNERS] atribuir:', e.message);
    return { ok: false, motivo: 'error' };
  }
}

// ─── Comisión por un pago real del abono ─────────────────────────────────────
// La llama routes_cobro.js cada vez que Mercado Pago confirma un pago. Repetir el aviso no duplica nada.
async function comisionPorPago({ negocioId, mpPagoId, monto }) {
  try {
    if (!negocioId || !mpPagoId || !(Number(monto) > 0)) return null;
    await asegurar();
    const pc = await pool.query(
      "SELECT pc.*, p.estado AS p_estado FROM partner_clientes pc JOIN partners p ON p.id = pc.partner_id WHERE pc.negocio_id=$1", [negocioId]);
    const c = pc.rows[0];
    if (!c) return null;
    const R = reglas();
    const base = Math.round((Number(monto) / (1 + R.iva)) * 100) / 100;   // lo que pagó, sin IVA
    const yaPago = await pool.query(
      "SELECT 1 FROM partner_comisiones WHERE negocio_id=$1 AND tipo IN ('alta','cartera') AND origen <> $2 AND estado <> 'anulada' LIMIT 1",
      [negocioId, String(mpPagoId)]);
    let tipo, fijo, carteraMonto = c.cartera_monto != null ? Number(c.cartera_monto) : R.cartera_monto;
    if (!yaPago.rows.length) {
      tipo = 'alta'; fijo = R.alta_monto;
      // Al primer pago se fija cuánto deja por mes: Elite solo si el partner YA era Elite en ese momento
      const pagando = await clientesPagando(c.partner_id);
      if (c.cartera_monto == null) carteraMonto = pagando >= R.elite_clientes ? R.elite_cartera_monto : R.cartera_monto;
      await pool.query('UPDATE partner_clientes SET primer_pago=COALESCE(primer_pago, NOW()), cartera_monto=COALESCE(cartera_monto, $2) WHERE negocio_id=$1', [negocioId, carteraMonto]);
    } else {
      tipo = 'cartera'; fijo = carteraMonto;
    }
    const pct = null;
    const comision = Math.round(Math.min(fijo, base) * 100) / 100;   // por comercio: monto fijo (nunca más de lo que pagó)
    const ins = await pool.query(
      `INSERT INTO partner_comisiones(partner_id, negocio_id, tipo, origen, base, pct, monto)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (partner_id, tipo, origen) DO NOTHING RETURNING id`,
      [c.partner_id, negocioId, tipo, String(mpPagoId), base, pct, comision]);
    if (!ins.rows.length) return null;
    const n = await pool.query('SELECT nombre FROM negocios WHERE id=$1', [negocioId]);
    const nombre = (n.rows[0] && n.rows[0].nombre) || 'Un negocio de tu cartera';
    avisarPartner(c.partner_id, tipo === 'alta'
      ? { titulo: `${nombre} pagó su primer abono: ganaste ${pesos(comision)}`, mensaje: `Es tu comisión de alta. Desde el mes que viene, cada mes que pague te deja ${pesos(carteraMonto)} mientras siga en LumoBi.` }
      : { titulo: `${nombre} pagó su abono: sumaste ${pesos(comision)}`, mensaje: 'Es tu comisión de cartera de este mes. Cuanto más tiempo se queda un negocio, más te deja.' });
    if (tipo === 'alta') await bonoPorInvitado(c.partner_id, negocioId);
    return { tipo, monto: comision };
  } catch (e) {
    console.error('[PARTNERS] comisionPorPago:', e.message);
    return null;
  }
}

async function clientesPagando(partnerId) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM partner_clientes WHERE partner_id=$1 AND primer_pago IS NOT NULL', [partnerId]);
  return r.rows[0].n;
}

// Quien invitó a este partner cobra un monto por cada comercio que el invitado trae y paga, hasta el tope (un solo nivel).
async function bonoPorInvitado(partnerId, negocioId) {
  const R = reglas();
  if (!(R.bono_por_negocio > 0) || !(R.bono_tope > 0)) return;
  const p = await pool.query('SELECT referido_por, nombre FROM partners WHERE id=$1', [partnerId]);
  const ref = p.rows[0] && p.rows[0].referido_por;
  if (!ref) return;
  const ya = await pool.query("SELECT COUNT(*)::int AS n FROM partner_comisiones WHERE partner_id=$1 AND tipo='bono_referido' AND referido_id=$2 AND estado <> 'anulada'", [ref, partnerId]);
  if (ya.rows[0].n >= R.bono_tope) return;
  const n = await pool.query('SELECT nombre FROM negocios WHERE id=$1', [negocioId]);
  const ins = await pool.query(
    `INSERT INTO partner_comisiones(partner_id, negocio_id, referido_id, tipo, origen, monto, nota)
     VALUES($1,NULL,$2,'bono_referido',$3,$4,$5) ON CONFLICT (partner_id, tipo, origen) DO NOTHING RETURNING id`,
    [ref, partnerId, 'ref:' + negocioId, R.bono_por_negocio, `${p.rows[0].nombre} sumó ${(n.rows[0] && n.rows[0].nombre) || 'un comercio'}`]);
  if (ins.rows.length) {
    const cuenta = ya.rows[0].n + 1;
    avisarPartner(ref, { titulo: `Ganaste ${pesos(R.bono_por_negocio)} por ${p.rows[0].nombre}`,
      mensaje: `${p.rows[0].nombre}, el partner que invitaste, sumó un comercio que ya pagó. Llevás ${cuenta} de ${R.bono_tope} comercios con él.` });
  }
}

// Pasa a "disponible" lo que ya cumplió la retención. Corre en el job horario.
async function liberarPendientes() {
  await asegurar();
  const r = await pool.query(
    `UPDATE partner_comisiones SET estado='disponible'
     WHERE estado='pendiente' AND creado <= NOW() - ($1 || ' days')::interval RETURNING id`, [String(reglas().retencion_dias)]);
  return r.rowCount;
}

// ─── Panel del partner ───────────────────────────────────────────────────────
async function panel(partnerId) {
  await asegurar();
  await liberarPendientes().catch(() => {});
  const R = reglas();
  const p = (await pool.query(
    'SELECT id, nombre, email, celular, zona, codigo, estado, cuit, alias_cbu, titular, creado, referido_por, formacion_completa FROM partners WHERE id=$1', [partnerId])).rows[0];
  if (!p) return null;
  const cli = await pool.query(
    `SELECT pc.negocio_id, n.nombre, n.tipo_negocio, pc.creado, pc.primer_pago, pc.cartera_monto,
            u.subscription_status AS st, u.trial_fin,
            EXISTS (SELECT 1 FROM transacciones t WHERE t.negocio_id = pc.negocio_id AND COALESCE(t.origin,'real')='real' LIMIT 1) AS vendio,
            EXISTS (SELECT 1 FROM turnos_caja tc WHERE tc.negocio_id = pc.negocio_id AND tc.estado='cerrado' LIMIT 1) AS cerro_turno,
            (SELECT k.base FROM partner_comisiones k WHERE k.negocio_id = pc.negocio_id AND k.tipo IN ('alta','cartera') AND k.estado <> 'anulada' ORDER BY k.creado DESC LIMIT 1)::float AS ultima_base,
            COALESCE((SELECT SUM(monto) FROM partner_comisiones k WHERE k.negocio_id = pc.negocio_id AND k.partner_id = pc.partner_id AND k.estado <> 'anulada'), 0)::float AS ganado
       FROM partner_clientes pc
       JOIN negocios n ON n.id = pc.negocio_id
       LEFT JOIN negocio_usuarios nu ON nu.negocio_id = pc.negocio_id AND nu.rol='owner' AND nu.activo = true
       LEFT JOIN usuarios u ON u.id = nu.usuario_id
      WHERE pc.partner_id = $1 ORDER BY pc.creado DESC`, [partnerId]);
  const ahora = Date.now();
  const clientes = cli.rows.map((c) => {
    let estado, detalle;
    const st = c.st;
    if (st === 'active' || st === 'activa') { estado = 'pagando'; detalle = 'Paga su abono'; }
    else if (st === 'cancelada' || st === 'cancelled') { estado = 'baja'; detalle = 'Canceló su abono'; }
    else if (st === 'trial' && (!c.trial_fin || new Date(c.trial_fin).getTime() > ahora)) {
      const d = c.trial_fin ? Math.ceil((new Date(c.trial_fin).getTime() - ahora) / 86400000) : null;
      estado = 'prueba'; detalle = d == null ? 'En prueba' : `En prueba: le ${d === 1 ? 'queda 1 día' : 'quedan ' + d + ' días'}`;
    } else if (!st) { estado = 'baja'; detalle = 'Cuenta dada de baja'; }
    else { estado = c.primer_pago ? 'baja' : 'sin_pagar'; detalle = c.primer_pago ? 'Dejó de pagar' : 'Terminó la prueba y no pagó'; }
    const paso = !c.vendio ? 'Todavía no hizo su primera venta' : !c.cerro_turno ? 'Vendió, pero no cerró ningún turno de caja' : 'Ya usa la caja';
    const mensual = estado === 'pagando' ? Math.min(c.cartera_monto != null ? Number(c.cartera_monto) : R.cartera_monto, c.ultima_base || Infinity) : 0;
    return { negocio_id: c.negocio_id, nombre: c.nombre, rubro: c.tipo_negocio, desde: c.creado, estado, detalle, arranque: paso, ganado: Math.round(c.ganado), mensual: Math.round(mensual) };
  });
  const sum = (await pool.query(
    `SELECT
       COALESCE(SUM(monto) FILTER (WHERE estado='pendiente'),0)::float AS pendiente,
       COALESCE(SUM(monto) FILTER (WHERE estado='disponible'),0)::float AS disponible,
       COALESCE(SUM(monto) FILTER (WHERE estado='liquidada'),0)::float AS cobrado,
       COALESCE(SUM(monto) FILTER (WHERE estado<>'anulada' AND creado >= date_trunc('month', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'),0)::float AS este_mes
     FROM partner_comisiones WHERE partner_id=$1`, [partnerId])).rows[0];
  const mov = await pool.query(
    `SELECT k.id, k.tipo, k.monto::float, k.estado, k.creado, k.nota, n.nombre AS negocio
       FROM partner_comisiones k LEFT JOIN negocios n ON n.id = k.negocio_id
      WHERE k.partner_id=$1 ORDER BY k.creado DESC LIMIT 60`, [partnerId]);
  const refs = await pool.query(
    `SELECT p.id, p.nombre, p.creado,
            (SELECT COUNT(*)::int FROM partner_clientes pc WHERE pc.partner_id = p.id AND pc.primer_pago IS NOT NULL) AS pagando,
            (SELECT COUNT(*)::int FROM partner_comisiones k WHERE k.partner_id=$1 AND k.tipo='bono_referido' AND k.referido_id = p.id AND k.estado <> 'anulada') AS bonos,
            COALESCE((SELECT SUM(monto) FROM partner_comisiones k WHERE k.partner_id=$1 AND k.tipo='bono_referido' AND k.referido_id = p.id AND k.estado <> 'anulada'),0)::float AS ganado
       FROM partners p WHERE p.referido_por = $1 ORDER BY p.creado DESC`, [partnerId]);
  const liq = await pool.query('SELECT id, total::float, estado, creado, pagada_en FROM partner_liquidaciones WHERE partner_id=$1 ORDER BY creado DESC LIMIT 12', [partnerId]);
  const pagando = clientes.filter((c) => c.estado === 'pagando').length;
  const elite = (await clientesPagando(partnerId)) >= R.elite_clientes;
  return {
    partner: {
      nombre: p.nombre, email: p.email, codigo: p.codigo, estado: p.estado, zona: p.zona, desde: p.creado, formacion: !!p.formacion_completa,
      cobro: { cuit: p.cuit, alias_cbu: p.alias_cbu, titular: p.titular, completo: !!(p.cuit && p.alias_cbu && p.titular) },
    },
    reglas: reglasPublicas(),
    resumen: {
      clientes: clientes.length, pagando, en_prueba: clientes.filter((c) => c.estado === 'prueba').length,
      este_mes: Math.round(sum.este_mes), pendiente: Math.round(sum.pendiente), disponible: Math.round(sum.disponible), cobrado: Math.round(sum.cobrado),
      cartera_mensual: clientes.reduce((a, c) => a + c.mensual, 0), elite,
    },
    clientes, movimientos: mov.rows, referidos: refs.rows, liquidaciones: liq.rows,
  };
}

// ─── Avisos al partner ───────────────────────────────────────────────────────
function pesos(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR'); }
function avisarPartner(partnerId, { titulo, mensaje }) {
  (async () => {
    const r = await pool.query("SELECT nombre, email FROM partners WHERE id=$1 AND estado='activo'", [partnerId]);
    if (!r.rows[0]) return;
    await require('./mailer').enviarPartner({ email: r.rows[0].email, nombre: r.rows[0].nombre, titulo, mensaje });
  })().catch((e) => console.error('[PARTNERS] aviso:', e.message));
}

module.exports = { asegurar, reglas, reglasPublicas, nuevoCodigo, normCodigo, porCodigo, atribuir, comisionPorPago, liberarPendientes, panel, clientesPagando, pesos, avisarPartner };
