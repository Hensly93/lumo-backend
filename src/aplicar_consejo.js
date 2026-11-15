// aplicar_consejo.js — el consejo con botón: LumoBi no solo dice "subí el precio" o "armá un combo", lo hace cuando el dueño toca el botón.
//   · Se vuelve a calcular en el servidor al aplicar (no se confía en lo que manda la pantalla).
//   · Un precio solo se cambia si sigue valiendo lo que LumoBi vio al armarlo (si cambió en el medio, se salta).
//   · Todo queda registrado (cambios_precios, origen 'consejo') y se puede deshacer.
const pool = require('./db');

async function aplicarPrecios(negocioId, a, db) {
  const { registrarCambio } = require('./cambios_precios');
  const hechos = [], saltados = [];
  for (const c of a.cambios || []) {
    const nuevo = Number(c.nuevo), antes = Number(c.antes);
    if (!c.producto_id || !(nuevo > 0) || !(antes > 0) || nuevo > antes * 1.5) { saltados.push({ nombre: c.nombre, motivo: 'El cambio no es seguro.' }); continue; }
    const p = (await db.query('SELECT id, nombre, precio_venta::float AS pv FROM productos WHERE id = $1 AND negocio_id = $2', [c.producto_id, negocioId])).rows[0];
    if (!p) { saltados.push({ nombre: c.nombre, motivo: 'No lo encontré en tu catálogo.' }); continue; }
    if (Math.abs(p.pv - antes) > 0.5) { saltados.push({ nombre: p.nombre, motivo: p.pv >= nuevo ? 'Ya tiene un precio igual o mayor.' : 'El precio cambió mientras tanto.' }); continue; }
    await db.query('UPDATE productos SET precio_venta = $1, updated_at = NOW() WHERE id = $2 AND negocio_id = $3', [nuevo, p.id, negocioId]);
    await db.query(`INSERT INTO productos_historico_precios(producto_id, negocio_id, precio_anterior, precio_nuevo, origen) VALUES($1,$2,$3,$4,'consejo')`, [p.id, negocioId, p.pv, nuevo]).catch(() => {});
    await registrarCambio({ negocio_id: negocioId, producto_id: p.id, producto_nombre: p.nombre, campo: 'precio_venta', valor_anterior: p.pv, valor_nuevo: nuevo, empleado: null, origen: 'consejo' }).catch(() => {});
    hechos.push({ producto_id: p.id, nombre: p.nombre, antes: p.pv, nuevo });
  }
  return { tipo: 'precios', hechos, saltados,
    texto: hechos.length ? `Listo: cambié el precio de ${hechos.length} ${hechos.length === 1 ? 'producto' : 'productos'}${saltados.length ? ` y salteé ${saltados.length}` : ''}. Ya valen en la caja.` : 'No cambié nada: los precios ya no coincidían con lo que calculé.' };
}

async function aplicarCombo(negocioId, usuarioId, a, db) {
  const nombre = String(a.nombre || '').slice(0, 120);
  const ya = (await db.query('SELECT id, activo FROM productos WHERE negocio_id = $1 AND LOWER(nombre) = LOWER($2) LIMIT 1', [negocioId, nombre])).rows[0];
  if (ya && ya.activo !== false) return { tipo: 'combo', hechos: [], saltados: [], ya_existia: true, producto_id: ya.id, texto: 'Ese combo ya está en tu catálogo.' };
  const ids = (a.productos || []).filter(Boolean);
  const duenos = ids.length ? (await db.query('SELECT COUNT(*)::int AS n FROM productos WHERE negocio_id = $1 AND id = ANY($2::int[])', [negocioId, ids])).rows[0].n : 0;
  if (!(a.precio > 0) || duenos !== ids.length) return { tipo: 'combo', hechos: [], saltados: [{ nombre, motivo: 'Faltan productos del combo en tu catálogo.' }], texto: 'No pude crear el combo.' };
  const r = await db.query(
    `INSERT INTO productos (usuario_id, nombre, categoria, precio_venta, precio_costo, unidad, activo, negocio_id) VALUES ($1,$2,'Combos',$3,$4,'unidad',true,$5) RETURNING id`,
    [usuarioId, nombre, a.precio, a.costo || null, negocioId]);
  await require('./cambios_precios').registrarCambio({ negocio_id: negocioId, producto_id: r.rows[0].id, producto_nombre: nombre, campo: 'producto_creado', valor_anterior: null, valor_nuevo: a.precio, empleado: null, origen: 'consejo' }).catch(() => {});
  return { tipo: 'combo', hechos: [{ producto_id: r.rows[0].id, nombre, nuevo: a.precio }], saltados: [], producto_id: r.rows[0].id,
    texto: `Listo: creé "${nombre}" a $${Math.round(a.precio).toLocaleString('es-AR')}. Ya lo podés cobrar desde la caja.` };
}

async function aplicar(negocioId, usuarioId, promo, db = pool) {
  const a = promo && promo.aplicar;
  if (!a) throw Object.assign(new Error('Este consejo no se puede aplicar con un botón.'), { status: 400 });
  if (a.tipo === 'precios') return aplicarPrecios(negocioId, a, db);
  if (a.tipo === 'combo') return aplicarCombo(negocioId, usuarioId, a, db);
  throw Object.assign(new Error('Acción desconocida.'), { status: 400 });
}

// Deshacer: vuelve cada precio a lo que era, solo si sigue valiendo lo que puso el consejo
async function deshacer(negocioId, hechos, tipo, db = pool) {
  let vueltos = 0;
  for (const h of hechos || []) {
    if (tipo === 'combo') {
      const r = await db.query(`UPDATE productos SET activo = false, updated_at = NOW() WHERE id = $1 AND negocio_id = $2 AND categoria = 'Combos'`, [h.producto_id, negocioId]);
      vueltos += r.rowCount; continue;
    }
    const r = await db.query('UPDATE productos SET precio_venta = $1, updated_at = NOW() WHERE id = $2 AND negocio_id = $3 AND ABS(precio_venta - $4) < 0.5', [h.antes, h.producto_id, negocioId, h.nuevo]);
    if (r.rowCount) {
      vueltos++;
      await require('./cambios_precios').registrarCambio({ negocio_id: negocioId, producto_id: h.producto_id, producto_nombre: h.nombre, campo: 'precio_venta', valor_anterior: h.nuevo, valor_nuevo: h.antes, empleado: null, origen: 'consejo_deshecho' }).catch(() => {});
    }
  }
  return { vueltos, texto: vueltos ? 'Listo, lo deshice.' : 'No hay nada para deshacer (los precios ya cambiaron de nuevo).' };
}

module.exports = { aplicar, deshacer };
