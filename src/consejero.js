// consejero.js — consejos en el momento justo, solo backend. Se suman a los detectores del Vigilante (avisos por push y mail, cada hora).
// Cada uno sale de los datos del negocio, llega cuando sirve y trae la acción lista (no un consejo suelto):
//   · consejo_dia_flojo      la noche anterior a tu día más flojo, con la promo ya armada y el texto para WhatsApp
//   · consejo_factura        al cargar una factura con aumentos: cuánto más pagás y a cuánto subir cada precio
//   · consejo_bajo_costo     el mismo día que vendiste algo por debajo de lo que te cuesta
//   · consejo_dormido        un producto que se vendía bien y hace una semana que no se vende
//   · consejo_semana         el lunes: cómo te fue la semana y lo más importante para esta
// Mismas reglas del Vigilante: sin repetir, pocos por día, nunca nombres de empleados.
const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const FL = "(t.fecha - INTERVAL '3 hours')";
const pesos = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const recorte = (s, n = 600) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const semanaDe = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / (7 * 86400000));
const dowDe = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
function mediana(v) { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const sumarDias = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const sinTabla = (e) => e && (e.code === '42P01' || e.code === '42703');   // tabla o columna que todavía no existe: no hay nada que aconsejar

// ── 1) La noche anterior al día más flojo, con la promo armada ─────────────────
async function detDiaFlojo(db, p) {
  const { reloj, dias, negocioId } = p;
  if (reloj.hora < 17.5 || reloj.hora >= 21.5) return [];
  const manana = (reloj.dow + 1) % 7;
  const hist = dias.filter((d) => d.dia < reloj.hoy);
  if (hist.length < 21) return [];
  const porDow = {};
  for (const d of hist) (porDow[dowDe(d.dia)] = porDow[dowDe(d.dia)] || []).push(d.total);
  const dowsConDatos = Object.keys(porDow).filter((k) => porDow[k].length >= 3);
  const vm = porDow[manana];
  if (!vm || vm.length < 3 || dowsConDatos.length < 5) return [];
  const medManana = mediana(vm);
  const medOtros = mediana(dowsConDatos.filter((k) => Number(k) !== manana).map((k) => mediana(porDow[k])));
  if (!(medOtros > 0) || !(medManana <= medOtros * 0.65)) return [];
  const promo = await require('./promo').armar(negocioId, { clave: 'dia_debil_' + manana, detector: 'dia_debil', monto: 0, positivo: false }, 'promo_dia', db);
  if (!promo || promo.sin_promo) return [];   // sin promo armada no hay consejo: sería una frase suelta
  const wa = promo.textos && promo.textos.whatsapp;
  return [{
    tipo: 'consejo_dia_flojo', contexto: `d${manana}-${reloj.hoy}`, pref: 'alertas_medias', prioridad: 3,
    titulo: `Mañana es ${DIAS_ES[manana]}, tu día más flojo: ya te armé la promo`,
    mensaje: recorte(`Un ${DIAS_ES[manana]} vendés unos ${pesos(medManana)} contra ${pesos(medOtros)} de un día normal. ${promo.nombre} a ${pesos(promo.precio_promo)} en vez de ${pesos(promo.precio_normal)}.${wa ? ' Texto para WhatsApp: ' + wa : ''}`),
    url: '/', boton: 'Ver la promo',
  }];
}

// ── 2) Al cargar una factura con aumentos ──────────────────────────────────────
async function detFactura(db, p) {
  const { negocioId } = p;
  let compra;
  try {
    compra = (await db.query(`SELECT id, proveedor FROM compras WHERE negocio_id = $1 AND creado >= NOW() - INTERVAL '48 hours' ORDER BY id DESC LIMIT 1`, [negocioId])).rows[0];
  } catch (e) { if (sinTabla(e)) return []; throw e; }
  if (!compra) return [];
  const filas = (await db.query(
    `WITH x AS (
       SELECT i.compra_id, i.descripcion, i.precio_unitario::float AS precio, i.cantidad::float AS cantidad,
              LAG(i.precio_unitario) OVER (PARTITION BY i.clave ORDER BY c.fecha, c.id) AS ant
         FROM compras_items i JOIN compras c ON c.id = i.compra_id WHERE c.negocio_id = $1 AND i.precio_unitario > 0)
     SELECT descripcion, precio, ant::float AS ant, cantidad FROM x
      WHERE compra_id = $2 AND ant > 0 AND precio / ant::float - 1 >= 0.05 ORDER BY (precio - ant::float) * cantidad DESC`, [negocioId, compra.id])).rows;
  if (!filas.length) return [];
  const extra = filas.reduce((s, x) => s + (x.precio - x.ant) * x.cantidad, 0);
  if (extra <= 0) return [];
  const top = filas.slice(0, 3).map((x) => `${x.descripcion} +${Math.round((x.precio / x.ant - 1) * 100)}%`).join(', ');
  const pr = await require('./promo').armarProveedores(negocioId, db);
  const precios = pr && !pr.sin_promo ? ' ' + pr.por_que.slice(0, 3).join(' ') : ' Cargá el costo nuevo en el catálogo y actualizá los precios de venta.';
  return [{
    tipo: 'consejo_factura', contexto: `compra-${compra.id}`, pref: 'alertas_medias', prioridad: 2,
    titulo: `${compra.proveedor} te subió precios en la última factura`,
    mensaje: recorte(`Con esta compra pagás ${pesos(extra)} más que la anterior (${top}).${precios}`),
    url: '/catalogo', boton: 'Actualizar precios',
  }];
}

// ── 3) El mismo día que se vendió por debajo del costo ─────────────────────────
async function detBajoCosto(db, p) {
  const { reloj, negocioId } = p;
  if (reloj.hora < 10 || reloj.hora >= 21.5) return [];
  let x;
  try {
    await require('./catalogo_marca').asegurar(db);
    x = (await db.query(
      `SELECT pr.id, pr.nombre, SUM(d.cantidad)::float AS u, SUM(d.cantidad * k.c - d.subtotal)::float AS perdida,
              (SUM(d.subtotal) / SUM(d.cantidad))::float AS cobrado, MAX(k.c)::float AS costo
         FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id JOIN productos pr ON pr.id = d.producto_id,
              LATERAL (SELECT COALESCE(d.costo_unitario, pr.precio_costo)::float AS c) k
        WHERE t.negocio_id = $1 AND pr.negocio_id = $1 AND ${FL}::date = $2::date AND d.cantidad > 0 AND k.c > 0 AND d.subtotal < d.cantidad * k.c
        GROUP BY pr.id ORDER BY perdida DESC LIMIT 1`, [negocioId, reloj.hoy])).rows[0];
  } catch (e) { if (sinTabla(e)) return []; throw e; }
  if (!x || x.perdida < 500) return [];
  const ideal = x.costo / 0.75;
  const paso = ideal >= 3000 ? 100 : ideal >= 1000 ? 50 : 10;
  const precio = Math.ceil(ideal / paso) * paso;
  return [{
    tipo: 'consejo_bajo_costo', contexto: `${reloj.hoy}-${x.id}`, pref: 'alertas_medias', prioridad: 2,
    titulo: `Hoy vendiste ${x.nombre} por debajo de lo que te cuesta`,
    mensaje: recorte(`Vendiste ${Math.round(x.u)} a ${pesos(x.cobrado)} y te cuesta ${pesos(x.costo)} cada uno: perdiste ${pesos(x.perdida)} hoy. Para ganar 25% tendrías que cobrarlo ${pesos(precio)}. Si el costo está mal cargado, corregilo en el catálogo.`),
    url: '/catalogo', boton: 'Corregir el precio',
  }];
}

// ── 4) Un producto que se vendía bien y hace una semana que no se vende ────────
async function detDormido(db, p) {
  const { reloj, dias, negocioId } = p;
  if (reloj.hora < 10 || reloj.hora >= 20) return [];
  const desde7 = sumarDias(reloj.hoy, -7);
  const tickets7 = dias.filter((d) => d.dia >= desde7 && d.dia < reloj.hoy).reduce((s, d) => s + d.n, 0);
  if (tickets7 < 25) return [];                     // el negocio estuvo parado: no es culpa del producto
  let x;
  try {
    x = (await db.query(
      `SELECT pr.id, pr.nombre,
              SUM(CASE WHEN ${FL}::date >= $3::date THEN d.cantidad ELSE 0 END)::float AS u7,
              SUM(CASE WHEN ${FL}::date < $3::date THEN d.cantidad ELSE 0 END)::float AS u30,
              MAX(${FL}::date)::text AS ultima
         FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id JOIN productos pr ON pr.id = d.producto_id
        WHERE t.negocio_id = $1 AND pr.negocio_id = $1 AND COALESCE(pr.activo, true) AND ${FL}::date >= $2::date AND ${FL}::date <= $4::date
        GROUP BY pr.id HAVING SUM(CASE WHEN ${FL}::date >= $3::date THEN d.cantidad ELSE 0 END) = 0
           AND SUM(CASE WHEN ${FL}::date < $3::date THEN d.cantidad ELSE 0 END) >= 20
        ORDER BY u30 DESC LIMIT 1`, [negocioId, sumarDias(reloj.hoy, -37), desde7, reloj.hoy])).rows[0];
  } catch (e) { if (sinTabla(e)) return []; throw e; }
  if (!x) return [];
  const dd = Math.round((Date.parse(reloj.hoy) - Date.parse(x.ultima)) / 86400000);
  return [{
    tipo: 'consejo_dormido', contexto: `p${x.id}-${semanaDe(reloj.hoy)}`, pref: 'alertas_medias', prioridad: 4,
    titulo: `Hace ${dd} días que no vendés ${x.nombre}`,
    mensaje: recorte(`Antes vendías unas ${Math.max(1, Math.round(x.u30 / 30 * 7))} por semana y se vendía con regularidad. Revisá si se quedó sin stock, si dejó de estar a la vista o si su precio quedó desparejo con el resto.`),
    url: '/catalogo', boton: 'Ver el producto',
  }];
}

// ── 5) El lunes: la semana pasada y lo más importante de esta ─────────────────
async function detSemana(db, p) {
  const { reloj, dias, negocioId } = p;
  if (reloj.dow !== 1 || reloj.hora < 9 || reloj.hora >= 13) return [];
  const suma = (a, b) => dias.filter((d) => d.dia >= sumarDias(reloj.hoy, a) && d.dia <= sumarDias(reloj.hoy, b));
  const pasada = suma(-7, -1), previa = suma(-14, -8);
  if (pasada.length < 4 || previa.length < 4) return [];
  const tp = pasada.reduce((s, d) => s + d.total, 0), tq = previa.reduce((s, d) => s + d.total, 0);
  let rad;
  try {
    const fn = (p.opts.fuentes && p.opts.fuentes.radiografia) || ((id) => require('./hallazgos').radiografia(id, db));
    rad = await fn(negocioId);
  } catch (e) { console.error('[CONSEJERO] semana', negocioId, e.message); return []; }
  const h = rad && rad.suficiente ? (rad.hallazgos || []).find((x) => !x.positivo) : null;
  if (!h) return [];
  const acc = (h.acciones || []).find((a) => a.arma) || (h.acciones || [])[0];
  const var_ = tq > 0 ? Math.round((tp / tq - 1) * 100) : null;
  return [{
    tipo: 'consejo_semana', contexto: 'sem-' + semanaDe(reloj.hoy), pref: 'resumen_diario', prioridad: 5,
    titulo: 'Tu semana: lo más importante para esta',
    mensaje: recorte(`La semana pasada vendiste ${pesos(tp)}${var_ == null ? '' : ` (${var_ >= 0 ? '+' : ''}${var_}% contra la anterior)`}. Lo más importante ahora: ${h.titulo}${h.monto_texto ? ' (' + h.monto_texto + ')' : ''}.${acc ? ' Qué hacer: ' + acc.titulo + '.' : ''}`),
    url: '/', boton: 'Ver mi negocio',
  }];
}

module.exports = { DETECTORES: [detDiaFlojo, detFactura, detBajoCosto, detDormido, detSemana], detDiaFlojo, detFactura, detBajoCosto, detDormido, detSemana };
