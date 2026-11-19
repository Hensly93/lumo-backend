// combos.js — LumoBi · combos temporales que LumoBi propone a partir de lo que se vende junto (18/11/2026).
//
// Flujo: LumoBi detecta un par que se lleva junto (se_vende_junto.js) -> propone el combo con precio, duración y lo que se estima que gana
// -> el dueño toca "Aceptar" -> el combo queda en la grilla de la caja del empleado hasta la fecha de fin, y después sale solo.
//
// El combo es un producto del catálogo (categoría 'Combos') con sus componentes. Al cobrarlo baja el stock de cada componente (venta_core.js).
// La estimación es honesta: cuenta lo que se podría sumar Y lo que se regala a quien ya compraba los dos productos.
//   · Se supone que 1 de cada 10 clientes que hoy lleva solo uno de los dos productos se suma al combo (ADOPCION). Es un supuesto, y se dice.
//   · Si el resultado neto no es positivo, no se recomienda.
const pool = require('./db');

const ADOPCION = 0.10;
const DURACIONES = [7, 14, 30];
const DIAS_BASE = 60;
let listo = null;

function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await db.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS combo_desde TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS combo_hasta TIMESTAMPTZ,
                      ADD COLUMN IF NOT EXISTS combo_componentes JSONB, ADD COLUMN IF NOT EXISTS combo_ahorro NUMERIC(12,2)`);
      await require('./acceso_rapido').asegurar(db);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

const fmt = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const cap = (s) => String(s || '').trim().replace(/^./, (c) => c.toUpperCase());

// Pura: dado el par, los precios, los costos, el precio del combo y la duración, estima el efecto. Sin base de datos, para poder probarla.
function estimar({ juntos, na, nb, dias_base, pa, pb, ca, cb, precio, dias }) {
  const f = dias / dias_base;
  const ahorro = pa + pb - precio;
  const soloA = Math.max(na - juntos, 0) * f, soloB = Math.max(nb - juntos, 0) * f, ya = juntos * f;
  const suman = (soloA + soloB) * ADOPCION;
  const sumanA = soloA * ADOPCION, sumanB = soloB * ADOPCION;     // sumanA: llevaban solo A y agregan B
  const ingresoExtra = sumanA * (precio - pa) + sumanB * (precio - pb);
  const regalado = ya * ahorro;                                    // descuento a quien igual compraba los dos
  const conCostos = ca > 0 && cb > 0;
  const margenExtra = conCostos ? sumanA * (precio - pa - cb) + sumanB * (precio - pb - ca) : null;
  return {
    combos_nuevos: Math.round(suman), combos_que_ya_compraban: Math.round(ya),
    facturacion_extra: Math.round(ingresoExtra - regalado), ingreso_extra: Math.round(ingresoExtra), descuento_regalado: Math.round(regalado),
    ganancia_neta: conCostos ? Math.round(margenExtra - regalado) : null,
    // Cuántos de los que hoy llevan solo uno tendrían que sumarse para que el combo no pierda (con costos cargados)
    adopcion_equilibrio_pct: conCostos && (soloA + soloB) > 0 && (soloA * (precio - pa - cb) + soloB * (precio - pb - ca)) > 0
      ? Math.round(regalado / ((soloA * (precio - pa - cb) + soloB * (precio - pb - ca)) ) * 100) : null,
  };
}

// La propuesta completa de un par, calculada en el servidor. Devuelve { ok:false, motivo } o { ok:true, ... }
async function proponer(negocioId, aId, bId, dias, db = pool) {
  const d = DURACIONES.includes(Number(dias)) ? Number(dias) : 14;
  const sj = await require('./se_vende_junto').calcular(negocioId, DIAS_BASE, db);
  if (!sj.suficiente) return { ok: false, motivo: sj.aviso };
  const [x, y] = [Number(aId), Number(bId)].sort((p, q) => p - q);
  const par = sj.pares.find((p) => p.a.id === x && p.b.id === y);
  if (!par) return { ok: false, motivo: 'Ese par ya no aparece entre los que se compran juntos.' };
  const pr = (await db.query('SELECT id, nombre, precio_venta::float AS pv, precio_costo::float AS costo FROM productos WHERE negocio_id=$1 AND id = ANY($2::int[]) AND COALESCE(activo,true)', [negocioId, [x, y]])).rows;
  const A = pr.find((p) => p.id === x), B = pr.find((p) => p.id === y);
  if (!A || !B || !(A.pv > 0) || !(B.pv > 0)) return { ok: false, motivo: 'Faltan el precio o el producto en tu catálogo.' };
  const normal = A.pv + B.pv;
  const costo = A.costo > 0 && B.costo > 0 ? A.costo + B.costo : 0;
  const calc = require('./promo').calcularPrecio(normal, costo);
  if (calc.error) return { ok: false, motivo: `Con los costos de ${cap(A.nombre)} y ${cap(B.nombre)} no queda margen para hacer un descuento sano.` };
  const est = estimar({ juntos: par.juntos, na: par.na, nb: par.nb, dias_base: sj.dias, pa: A.pv, pb: B.pv, ca: A.costo, cb: B.costo, precio: calc.precio, dias: d });
  const base = { a: { id: A.id, nombre: cap(A.nombre), precio: A.pv }, b: { id: B.id, nombre: cap(B.nombre), precio: B.pv }, dias: d, duraciones: DURACIONES,
    nombre: `Combo ${cap(A.nombre)} + ${cap(B.nombre)}`, precio_normal: normal, precio: calc.precio, ahorro: calc.ahorro, descuento_pct: calc.pct, costo: costo || null,
    juntos: par.juntos, ventana_dias: sj.dias, estimacion: est, supuesto: `Se supone que 1 de cada ${Math.round(1 / ADOPCION)} clientes que hoy lleva solo uno de los dos se suma al combo. Es una estimación, no una promesa.`, aviso: calc.aviso };
  const neto = est.ganancia_neta != null ? est.ganancia_neta : est.facturacion_extra;
  if (!(neto > 0)) {
    const eq = est.adopcion_equilibrio_pct;
    return { ...base, ok: false, motivo: 'Con el descuento que habría que hacer, lo que se regala a quienes ya compran los dos supera lo que se podría sumar. No te lo recomiendo.' +
      (eq ? ` Para que no pierda, tendrían que sumarse ${eq}% de los que hoy llevan solo uno (yo supuse ${Math.round(ADOPCION * 100)}%).` : '') };
  }
  return { ...base, ok: true };
}

// "Aceptar": el combo se crea (o se reactiva) con fecha de fin y va directo a la grilla de la caja
async function aceptar(negocioId, usuarioId, aId, bId, dias, db = pool) {
  await asegurar(db);
  const p = await proponer(negocioId, aId, bId, dias, db);
  if (!p.ok) throw Object.assign(new Error(p.motivo || 'No se puede armar este combo.'), { status: 400 });
  const comps = JSON.stringify([{ id: p.a.id, cantidad: 1 }, { id: p.b.id, cantidad: 1 }]);
  const fin = `((NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date + $1::int + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires' - INTERVAL '1 second'`;
  const ya = (await db.query('SELECT id FROM productos WHERE negocio_id=$1 AND LOWER(nombre)=LOWER($2) AND categoria=$3 LIMIT 1', [negocioId, p.nombre, 'Combos'])).rows[0];
  let id;
  if (ya) {
    id = ya.id;
    await db.query(`UPDATE productos SET activo=true, precio_venta=$2, precio_costo=$3, combo_desde=NOW(), combo_hasta=${fin.replace('$1', '$4')}, combo_componentes=$5::jsonb, combo_ahorro=$6, updated_at=NOW() WHERE id=$1 AND negocio_id=$7`,
      [id, p.precio, p.costo, p.dias, comps, p.ahorro, negocioId]);
  } else {
    id = (await db.query(`INSERT INTO productos (usuario_id, nombre, categoria, precio_venta, precio_costo, unidad, activo, negocio_id, combo_desde, combo_hasta, combo_componentes, combo_ahorro)
      VALUES ($1,$2,'Combos',$3,$4,'unidad',true,$5,NOW(),${fin.replace('$1', '$6')},$7::jsonb,$8) RETURNING id`, [usuarioId, p.nombre, p.precio, p.costo, negocioId, p.dias, comps, p.ahorro])).rows[0].id;
  }
  await require('./cambios_precios').registrarCambio({ negocio_id: negocioId, producto_id: id, producto_nombre: p.nombre, campo: 'producto_creado', valor_anterior: null, valor_nuevo: p.precio, empleado: null, origen: 'combo' }).catch(() => {});
  let enCaja = true, avisoCaja = null;
  const m = await require('./acceso_rapido').marcar(negocioId, id, true, db).catch(() => ({ ok: false }));
  if (!m.ok) { enCaja = false; avisoCaja = 'La grilla de la caja está llena: el combo se cobra buscándolo por nombre.'; }
  const hasta = (await db.query('SELECT combo_hasta FROM productos WHERE id=$1', [id])).rows[0].combo_hasta;
  return { ok: true, producto_id: id, nombre: p.nombre, precio: p.precio, hasta, en_grilla_de_caja: enCaja, aviso: avisoCaja,
    texto: `Listo: "${p.nombre}" a ${fmt(p.precio)} ya está en la caja de tus empleados hasta el ${new Date(hasta).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'long' })}.` };
}

// Combos del negocio con lo que pasó mientras estuvieron en la caja
async function listar(negocioId, db = pool) {
  await asegurar(db);
  const r = await db.query(
    `SELECT p.id, p.nombre, p.precio_venta::float AS precio, p.combo_ahorro::float AS ahorro, p.combo_desde, p.combo_hasta,
            (COALESCE(p.activo,true) AND p.combo_hasta >= NOW()) AS vigente,
            COALESCE(v.u,0)::float AS vendidos, COALESCE(v.imp,0)::float AS facturado
       FROM productos p
       LEFT JOIN LATERAL (
         SELECT SUM(d.cantidad) AS u, SUM(d.subtotal) AS imp
           FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
          WHERE d.producto_id = p.id AND COALESCE(t.tipo,'venta') = 'venta' AND t.fecha >= p.combo_desde
            AND NOT EXISTS (SELECT 1 FROM transacciones a WHERE a.anula_id = t.id)) v ON true
      WHERE p.negocio_id = $1 AND p.combo_componentes IS NOT NULL
      ORDER BY p.combo_desde DESC LIMIT 20`, [negocioId]);
  return r.rows.map((x) => ({ ...x, vendidos: Math.round(x.vendidos), facturado: Math.round(x.facturado), descuento_dado: Math.round(x.vendidos * (x.ahorro || 0)) }));
}

// Los combos vencidos salen de la caja (se llama cada hora desde el vigilante)
async function vencer(db = pool) {
  await asegurar(db);
  const r = await db.query(`UPDATE productos SET activo = false, acceso_rapido = false, updated_at = NOW()
                             WHERE combo_hasta IS NOT NULL AND combo_hasta < NOW() AND (activo IS NOT FALSE OR acceso_rapido)`);
  return r.rowCount;
}

// Para el stock: vender un combo baja cada componente, no el combo. Devuelve los ítems con el combo reemplazado por sus partes.
async function expandirParaStock(client, items) {
  const ids = [...new Set(items.map((i) => i.producto_id).filter(Boolean))];
  if (!ids.length) return items;
  const r = await client.query('SELECT id, combo_componentes FROM productos WHERE id = ANY($1::int[]) AND combo_componentes IS NOT NULL', [ids]);
  if (!r.rows.length) return items;
  const mapa = new Map(r.rows.map((x) => [x.id, x.combo_componentes]));
  const out = [];
  for (const it of items) {
    const comps = it.producto_id && mapa.get(it.producto_id);
    if (!comps) { out.push(it); continue; }
    for (const c of comps) out.push({ ...it, producto_id: c.id, cantidad: Number(it.cantidad) * Number(c.cantidad || 1) });
  }
  return out;
}

module.exports = { asegurar, estimar, proponer, aceptar, listar, vencer, expandirParaStock, ADOPCION, DURACIONES };
