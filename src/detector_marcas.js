// detector_marcas.js — lo que LumoBi sabe por producto y marca porque las ventas nacen con su costo.
//  1) precio_bajo_costo: ventas hechas por debajo de lo que cuesta el producto (plata perdida medida, últimos 30 días).
//  2) marca_margen_bajo: una marca que pesa mucho en las ventas pero deja bastante menos margen que el resto (estimación prudente).
//  Y arma la lista de precios corregidos (armarPrecios): para cada producto con margen flojo, el precio que lo lleva a un margen sano.
const pool = require('./db');

const FL = "(t.fecha - INTERVAL '3 hours')";
const HOY_AR = "(NOW() - INTERVAL '3 hours')::date";
const DIAS = 30;
const MARGEN_OBJETIVO = 0.25;   // mismo piso de margen que usan las promos
const MIN_PESO_MARCA = 0.12;    // la marca tiene que ser al menos 12% de lo vendido con costo
const MIN_BRECHA = 0.10;        // y dejar 10 puntos menos de margen que el promedio del negocio
const MIN_COBERTURA = 0.7;      // y tener el costo cargado en al menos el 70% de lo que vende
const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('es-AR');
const cap = (s) => String(s || '').trim().replace(/^./, (c) => c.toUpperCase());

async function porProducto(negocioId, db, dias) {
  try {
    await require('./catalogo_marca').asegurar(db);
    return (await db.query(
      `SELECT p.id, p.nombre, COALESCE(NULLIF(d.producto_marca, ''), NULLIF(p.marca, '')) AS marca,
              SUM(d.cantidad)::float AS u, SUM(d.subtotal)::float AS monto,
              SUM(CASE WHEN k.c > 0 THEN d.subtotal ELSE 0 END)::float AS monto_cc,
              SUM(CASE WHEN k.c > 0 THEN d.cantidad * k.c ELSE 0 END)::float AS costo_total,
              SUM(CASE WHEN k.c > 0 AND d.subtotal < d.cantidad * k.c THEN d.cantidad * k.c - d.subtotal ELSE 0 END)::float AS perdida,
              SUM(CASE WHEN k.c > 0 AND d.subtotal < d.cantidad * k.c THEN d.cantidad ELSE 0 END)::float AS u_perdida
         FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id JOIN productos p ON p.id = d.producto_id,
              LATERAL (SELECT COALESCE(d.costo_unitario, p.precio_costo)::float AS c) k
        WHERE t.negocio_id = $1 AND p.negocio_id = $1 AND ${FL}::date >= ${HOY_AR} - ($2::int - 1) AND d.cantidad > 0
        GROUP BY p.id, 3`, [negocioId, dias])).rows;
  } catch (e) { if (e.code === '42P01') return []; throw e; }
}

async function detectarMarcas(negocioId, db = pool) {
  const filas = await porProducto(negocioId, db, DIAS);
  if (!filas.length) return [];
  const out = [];

  // 1) Vendió por debajo del costo
  const bajos = filas.filter((x) => x.perdida > 0).sort((a, b) => b.perdida - a.perdida);
  const perdida = Math.round(bajos.reduce((s, x) => s + x.perdida, 0));
  if (perdida > 0) {
    out.push({
      id: 'precio_bajo_costo', tipo: 'calculado',
      titulo: `Vendiste ${bajos.length === 1 ? 'un producto' : bajos.length + ' productos'} por debajo de lo que te cuesta: perdiste ${fmt(perdida)} en el último mes`,
      detalle: 'Cada venta de estos productos te dejó menos plata de la que pusiste para comprarlos.',
      evidencia: [
        ...bajos.slice(0, 3).map((x) => `${cap(x.nombre)}${x.marca ? ' (' + x.marca + ')' : ''}: ${Math.round(x.u_perdida)} ${Math.round(x.u_perdida) === 1 ? 'unidad vendida' : 'unidades vendidas'} bajo el costo, ${fmt(x.perdida)} de pérdida.`),
        'Es el costo cargado de cada producto menos lo que cobraste. Si el costo está mal cargado, corregilo en el catálogo y desaparece.',
      ],
      monto: perdida, monto_texto: `${fmt(perdida)} perdidos en el mes`, url: '/catalogo',
    });
  }

  // 2) Una marca que pesa mucho y deja poco margen
  const conCosto = filas.filter((x) => x.monto_cc > 0 && !(x.perdida > 0));   // sin lo vendido bajo el costo, que ya tiene su propio hallazgo
  const totalCC = conCosto.reduce((s, x) => s + x.monto_cc, 0);
  const totalCosto = conCosto.reduce((s, x) => s + x.costo_total, 0);
  if (totalCC > 0) {
    const prom = (totalCC - totalCosto) / totalCC;
    const m = new Map();
    for (const x of filas.filter((y) => y.marca && !(y.perdida > 0))) {   // lo vendido bajo el costo ya lo explica el otro hallazgo
      const a = m.get(x.marca) || { marca: x.marca, monto: 0, cc: 0, costo: 0, productos: 0 };
      a.monto += x.monto; a.cc += x.monto_cc; a.costo += x.costo_total; a.productos += 1; m.set(x.marca, a);
    }
    const marcas = [...m.values()].filter((a) => a.cc > 0);
    if (marcas.length >= 3) {
      const malas = marcas
        .map((a) => ({ ...a, margen: (a.cc - a.costo) / a.cc, peso: a.cc / totalCC, cobertura: a.monto > 0 ? a.cc / a.monto : 0 }))
        .filter((a) => a.peso >= MIN_PESO_MARCA && a.cobertura >= MIN_COBERTURA && prom - a.margen >= MIN_BRECHA)
        .map((a) => ({ ...a, extra: (prom - a.margen) * a.cc }))
        .sort((a, b) => b.extra - a.extra);
      if (malas.length) {
        const w = malas[0];
        const monto = Math.round(w.extra / 3);   // estimación prudente: solo un tercio de la brecha
        if (monto > 0) out.push({
          id: 'marca_margen_bajo', tipo: 'estimado',
          titulo: `${w.marca} pesa mucho en tus ventas, pero te deja poco margen`,
          detalle: `Deja ${Math.round(w.margen * 100)}% de margen contra ${Math.round(prom * 100)}% del promedio de tu negocio.`,
          evidencia: [
            `${w.marca}: ${Math.round(w.peso * 100)}% de tus ventas con costo cargado, con ${w.productos} ${w.productos === 1 ? 'producto' : 'productos'}.`,
            `Margen de ${w.marca}: ${Math.round(w.margen * 100)}%. Margen del resto del negocio: ${Math.round(prom * 100)}%.`,
            'Es una estimación prudente: cuenta solo un tercio de lo que ganarías si esta marca llegara al margen promedio.',
          ],
          monto, monto_texto: `hasta ${fmt(monto)} por mes si ajustás sus precios`, url: '/catalogo',
        });
      }
    }
  }
  return out;
}

// Lista de precios corregidos: productos que venden con margen flojo y el precio que los lleva a un margen sano (subiendo hasta 20% por vez).
async function armarPrecios(negocioId, db = pool) {
  let filas;
  try {
    await require('./catalogo_marca').asegurar(db);
    filas = (await db.query(
      `SELECT p.nombre, p.marca, p.precio_venta::float AS pv, p.precio_costo::float AS costo, SUM(d.cantidad)::float AS u
         FROM productos p JOIN transacciones_detalle d ON d.producto_id = p.id JOIN transacciones t ON t.id = d.transaccion_id
        WHERE p.negocio_id = $1 AND t.negocio_id = $1 AND COALESCE(p.activo, true) AND p.precio_venta > 0 AND p.precio_costo > 0
          AND p.precio_costo / p.precio_venta > $2::float AND ${FL}::date >= ${HOY_AR} - 89
        GROUP BY p.id ORDER BY SUM(d.subtotal) DESC LIMIT 8`, [negocioId, 1 - MARGEN_OBJETIVO])).rows;
  } catch (e) { if (e.code === '42P01') filas = []; else throw e; }
  if (!filas.length) return { sin_promo: true, motivo: 'No encontré productos vendidos con margen flojo y costo cargado. Si el costo de tus productos está sin cargar, completalo en el catálogo y lo calculo.' };
  const items = filas.map((x) => {
    const paso = x.pv >= 3000 ? 100 : x.pv >= 1000 ? 50 : 10;
    const ideal = x.costo / (1 - MARGEN_OBJETIVO);
    const tope = x.pv * 1.2;
    const nuevo = Math.ceil(Math.min(ideal, tope) / paso) * paso;
    return { nombre: cap(x.nombre), marca: x.marca, pv: x.pv, nuevo, subida: Math.round((nuevo / x.pv - 1) * 100), margen_hoy: Math.round((1 - x.costo / x.pv) * 100), margen_nuevo: Math.round((1 - x.costo / nuevo) * 100), en_pasos: ideal > tope };
  }).filter((x) => x.nuevo > x.pv);
  if (!items.length) return { sin_promo: true, motivo: 'Con los costos cargados, tus precios ya dejan un margen sano. No hace falta cambiar nada.' };
  return {
    sin_promo: false, nombre: 'Precios corregidos para recuperar margen', cuando: '',
    resumen: `Subí el precio de ${items.length} ${items.length === 1 ? 'producto' : 'productos'} que hoy te dejan poco margen.`,
    por_que: [
      ...items.map((x) => `${x.nombre}${x.marca ? ' (' + x.marca + ')' : ''}: de ${fmt(x.pv)} a ${fmt(x.nuevo)} (+${x.subida}%). ${x.margen_hoy < 0 ? 'Hoy lo vendés por debajo del costo' : `Hoy te deja ${x.margen_hoy}%`} y pasaría a dejarte ${x.margen_nuevo}%.`),
      items.some((x) => x.en_pasos) ? 'En los que la suba completa sería muy grande, subí hasta el 20% ahora y mirá cómo responden las ventas antes de seguir.' : null,
      `El objetivo es un margen de al menos ${Math.round(MARGEN_OBJETIVO * 100)}% sobre el precio.`,
    ].filter(Boolean),
    aviso: 'LumoBi no cambia tus precios solo: los cargás vos en el catálogo. Si el costo de algún producto está mal cargado, corregilo primero.',
    textos: { lista: 'Precios nuevos:\n' + items.map((x) => `${x.nombre}: ${fmt(x.nuevo)}`).join('\n') },
  };
}

module.exports = { detectarMarcas, armarPrecios, MARGEN_OBJETIVO };
