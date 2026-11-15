// pedidos.js — qué pedir, cuánto y a quién (14/11/2026).
// Con el stock que baja solo en cada venta y el ritmo de venta real (últimas 4 semanas, descontando anulaciones),
// LumoBi calcula para cuántos días alcanza cada producto y cuánto pedir para cubrir las próximas 2 semanas.
// Agrupa por proveedor (el de la última factura cargada de ese producto). Solo productos con control de stock.
const pool = require('./db');

const DIAS_VENTANA = 28;      // ritmo de venta: últimas 4 semanas
const COBERTURA = 14;         // el pedido cubre 2 semanas
const URGENTE_DIAS = 3;       // 3 días o menos: pedir ya
const PRONTO_DIAS = 7;        // hasta una semana: pedir esta semana

async function calcular(negocioId, db = pool) {
  const r = await db.query(
    `SELECT p.id, p.nombre, p.marca, p.unidad, p.stock::float AS stock, p.stock_minimo::float AS minimo,
            p.precio_costo::float AS costo,
            COALESCE(v.u,0)::float AS vendido, v.dias_con_venta, v.dias_base,
            pr.proveedor, pr.fecha AS ultima_compra, pr.precio AS precio_compra
       FROM productos p
       LEFT JOIN LATERAL (
         SELECT SUM(d.cantidad) AS u, COUNT(DISTINCT (t.fecha - INTERVAL '3 hours')::date) FILTER (WHERE t.tipo = 'venta') AS dias_con_venta,
                GREATEST(7, LEAST($2::int, CEIL(EXTRACT(EPOCH FROM (NOW() - MIN(t.fecha))) / 86400)))::int AS dias_base
           FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
          WHERE t.negocio_id = $1 AND d.producto_id = p.id AND t.tipo IN ('venta','anulacion')
            AND t.fecha >= NOW() - ($2::int * INTERVAL '1 day')) v ON true
       LEFT JOIN LATERAL (
         SELECT c.proveedor, c.fecha::text AS fecha, i.precio_unitario::float AS precio
           FROM compras_items i JOIN compras c ON c.id = i.compra_id
          WHERE c.negocio_id = $1 AND i.producto_id = p.id ORDER BY c.fecha DESC, c.id DESC LIMIT 1) pr ON true
      WHERE p.negocio_id = $1 AND COALESCE(p.activo, true) AND p.stock IS NOT NULL`, [negocioId, DIAS_VENTANA]).catch(async (e) => {
      // Sin tabla de compras todavía: se calcula igual, sin proveedor
      if (!/compras/.test(e.message)) throw e;
      return db.query(
        `SELECT p.id, p.nombre, p.marca, p.unidad, p.stock::float AS stock, p.stock_minimo::float AS minimo, p.precio_costo::float AS costo,
                COALESCE(v.u,0)::float AS vendido, v.dias_con_venta, v.dias_base, NULL AS proveedor, NULL AS ultima_compra, NULL AS precio_compra
           FROM productos p LEFT JOIN LATERAL (
             SELECT SUM(d.cantidad) AS u, COUNT(DISTINCT (t.fecha - INTERVAL '3 hours')::date) FILTER (WHERE t.tipo = 'venta') AS dias_con_venta,
                GREATEST(7, LEAST($2::int, CEIL(EXTRACT(EPOCH FROM (NOW() - MIN(t.fecha))) / 86400)))::int AS dias_base
               FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
              WHERE t.negocio_id = $1 AND d.producto_id = p.id AND t.tipo IN ('venta','anulacion') AND t.fecha >= NOW() - ($2::int * INTERVAL '1 day')) v ON true
          WHERE p.negocio_id = $1 AND COALESCE(p.activo, true) AND p.stock IS NOT NULL`, [negocioId, DIAS_VENTANA]);
    });

  const items = [];
  for (const p of r.rows) {
    // Ritmo: lo vendido dividido por los días desde la primera venta (un producto nuevo no se diluye en 4 semanas)
    const porDia = p.vendido > 0 ? p.vendido / (p.dias_base || DIAS_VENTANA) : 0;
    // Con menos de 3 días con ventas el ritmo no es confiable, salvo que esté agotado o bajo el mínimo
    const confiable = (p.dias_con_venta || 0) >= 3;
    const bajoMinimo = p.minimo != null && p.minimo > 0 && p.stock <= p.minimo;
    if (!(porDia > 0 && confiable) && !bajoMinimo && !(p.stock <= 0 && p.vendido > 0)) continue;
    const dias = porDia > 0 ? Math.max(0, p.stock) / porDia : null;
    if (dias != null && dias > PRONTO_DIAS && !bajoMinimo) continue;
    const kg = p.unidad === 'kg';
    let pedir = porDia * COBERTURA - Math.max(0, p.stock);
    if (bajoMinimo && pedir <= 0) pedir = Math.max(p.minimo * 2 - p.stock, 1);
    pedir = kg ? Math.ceil(pedir * 10) / 10 : Math.ceil(pedir);
    if (!(pedir > 0)) continue;
    const costoU = p.precio_compra || p.costo || null;
    const urgencia = p.stock <= 0 ? 'agotado' : dias != null && dias <= URGENTE_DIAS ? 'ya' : 'esta_semana';
    items.push({
      id: p.id, nombre: p.nombre, marca: p.marca, unidad: kg ? 'kg' : 'u.',
      stock: p.stock, por_dia: Math.round(porDia * 10) / 10, alcanza_dias: dias != null ? Math.floor(dias) : null,
      pedir, costo_estimado: costoU ? Math.round(costoU * pedir) : null,
      proveedor: p.proveedor || null, ultima_compra: p.ultima_compra || null, urgencia,
      porque: p.stock <= 0 ? `Está agotado y se vende ${(Math.round(porDia * 7 * 10) / 10).toLocaleString('es-AR')} ${kg ? 'kg' : 'unidades'} por semana`
        : dias != null ? `Quedan ${Math.round(p.stock * 10) / 10}: alcanzan para ${Math.floor(dias)} ${Math.floor(dias) === 1 ? 'día' : 'días'}`
        : `Está por debajo del mínimo (${p.minimo})`,
    });
  }
  const orden = { agotado: 0, ya: 1, esta_semana: 2 };
  items.sort((a, b) => orden[a.urgencia] - orden[b.urgencia] || (a.alcanza_dias ?? 0) - (b.alcanza_dias ?? 0));

  // Agrupado por proveedor (lo que no tiene factura cargada va a "Sin proveedor")
  const grupos = new Map();
  for (const it of items) {
    const k = it.proveedor || 'Sin proveedor cargado';
    if (!grupos.has(k)) grupos.set(k, { proveedor: k, items: [], total: 0 });
    const g = grupos.get(k); g.items.push(it); g.total += it.costo_estimado || 0;
  }
  return {
    cobertura_dias: COBERTURA,
    urgentes: items.filter((x) => x.urgencia !== 'esta_semana').length,
    items,
    por_proveedor: [...grupos.values()].map((g) => ({ ...g, total: Math.round(g.total) })),
    sin_control: (await db.query(`SELECT COUNT(*)::int AS n FROM productos WHERE negocio_id = $1 AND COALESCE(activo,true) AND stock IS NULL`, [negocioId])).rows[0].n,
  };
}

// Texto para mandar el pedido por WhatsApp al proveedor
function textoPedido(grupo, negocio) {
  const l = [`Hola! Pedido de ${negocio || 'nuestro negocio'}:`, ''];
  for (const it of grupo.items) l.push(`• ${it.nombre}${it.marca ? ' ' + it.marca : ''}: ${it.pedir.toLocaleString('es-AR')} ${it.unidad}`);
  l.push('', 'Gracias!');
  return l.join('\n');
}

module.exports = { calcular, textoPedido, COBERTURA };
