// cruce_catalogo.js — Lumo S17
// Integración entre catálogo de productos y comportamiento real de ventas.
//
// Función 1: cruzarCatalogoConTicket
//   Compara ticket promedio real (transacciones) vs precio promedio del catálogo.
//   Si divergen ≥20% → señal para NICOLE.
//
// Función 2: detectarPreciosDesactualizados
//   Detecta productos sin actualizar hace >30 días y sugiere precio ajustado
//   por inflación estimada (4% mensual — referencia Argentina).
//   NO actualiza automáticamente — solo sugiere, el dueño confirma.

const pool = require('./db');

const INFLACION_MENSUAL    = 0.04;  // 4% estimado Argentina
const DIAS_STALE           = 30;    // días sin actualizar para considerar desactualizado
const UMBRAL_DIVERGENCIA   = 0.20;  // 20% de divergencia ticket vs catálogo
const MIN_PRODUCTOS_ACTIVOS = 3;
const MIN_TX_TICKET        = 10;

// ─── 1. Cruce ticket real vs precio promedio del catálogo ─────────────────────

async function cruzarCatalogoConTicket(usuarioId, sucursalId = null) {
  const catRes = await pool.query(
    `SELECT AVG(precio_venta) AS precio_promedio, COUNT(*) AS n_productos
     FROM productos
     WHERE usuario_id=$1 AND activo=true AND precio_venta IS NOT NULL`,
    [usuarioId]
  );

  const { precio_promedio, n_productos } = catRes.rows[0];
  if (!precio_promedio || parseInt(n_productos) < MIN_PRODUCTOS_ACTIVOS) {
    return { disponible: false, motivo: 'catalogo_insuficiente' };
  }

  const txRes = await pool.query(
    `SELECT AVG(monto) AS ticket_real, COUNT(*) AS n_tx
     FROM transacciones
     WHERE usuario_id=$1
       AND ($2::integer IS NULL OR sucursal_id=$2)
       AND fecha >= NOW() - INTERVAL '30 days'
       AND monto > 0`,
    [usuarioId, sucursalId]
  );

  const { ticket_real, n_tx } = txRes.rows[0];
  if (!ticket_real || parseInt(n_tx) < MIN_TX_TICKET) {
    return { disponible: false, motivo: 'transacciones_insuficientes' };
  }

  const promCatalogo = parseFloat(precio_promedio);
  const ticketReal   = parseFloat(ticket_real);
  const desvioPct    = (ticketReal - promCatalogo) / promCatalogo;
  const diverge      = Math.abs(desvioPct) >= UMBRAL_DIVERGENCIA;

  return {
    disponible: true,
    precio_promedio_catalogo: Math.round(promCatalogo),
    ticket_promedio_real:     Math.round(ticketReal),
    desvio_pct:               Math.round(desvioPct * 100),
    señal: diverge ? {
      tipo:      'TICKET_VS_CATALOGO',
      prioridad: 'atencion',
      contexto:  'ticket_vs_catalogo',
      mensaje: desvioPct < 0
        ? `Tu ticket promedio ($${Math.round(ticketReal).toLocaleString('es-AR')}) está ${Math.abs(Math.round(desvioPct * 100))}% por debajo del precio promedio de tu catálogo ($${Math.round(promCatalogo).toLocaleString('es-AR')})`
        : `Tu ticket promedio ($${Math.round(ticketReal).toLocaleString('es-AR')}) supera el precio promedio del catálogo en ${Math.round(desvioPct * 100)}%`,
      accion: desvioPct < 0
        ? 'Revisá si los precios del catálogo están actualizados o si hay descuentos no registrados.'
        : 'Puede haber combos o productos de alto valor que no están en el catálogo.',
      datos: {
        precio_promedio_catalogo: Math.round(promCatalogo),
        ticket_real:              Math.round(ticketReal),
        desvio_pct:               Math.round(desvioPct * 100),
        n_productos:              parseInt(n_productos),
        n_tx:                     parseInt(n_tx),
      },
    } : null,
  };
}

// ─── 2. Precios desactualizados ───────────────────────────────────────────────

async function detectarPreciosDesactualizados(usuarioId) {
  const res = await pool.query(
    `SELECT id, nombre, categoria, precio_venta, updated_at
     FROM productos
     WHERE usuario_id=$1 AND activo=true AND precio_venta IS NOT NULL
       AND updated_at < NOW() - INTERVAL '${DIAS_STALE} days'
     ORDER BY updated_at ASC
     LIMIT 20`,
    [usuarioId]
  );

  if (res.rows.length === 0) return [];

  const hoy = Date.now();
  return res.rows.map(p => {
    const diasSin       = Math.floor((hoy - new Date(p.updated_at).getTime()) / 86400000);
    const mesesSin      = diasSin / 30;
    const precioActual  = parseFloat(p.precio_venta);
    const precioSugerido = Math.round(precioActual * Math.pow(1 + INFLACION_MENSUAL, mesesSin));
    const incrementoPct  = Math.round(((precioSugerido - precioActual) / precioActual) * 100);

    return {
      id:               p.id,
      nombre:           p.nombre,
      categoria:        p.categoria,
      precio_actual:    precioActual,
      precio_sugerido:  precioSugerido,
      incremento_pct:   incrementoPct,
      dias_sin_actualizar: diasSin,
    };
  });
}

// ─── 3. Señal NICOLE para precios masivamente desactualizados ─────────────────
// Solo genera señal si hay ≥3 productos stale para no ser ruidoso.

async function señalPreciosDesactualizados(usuarioId) {
  const stale = await detectarPreciosDesactualizados(usuarioId);
  if (stale.length < 3) return null;

  const nombreEj = stale[0].nombre;
  const diasEj   = stale[0].dias_sin_actualizar;

  return {
    tipo:      'PRECIOS_DESACTUALIZADOS',
    prioridad: 'ineficiencia',
    contexto:  'catalogo_precios',
    mensaje:   `${stale.length} productos sin actualizar hace más de ${DIAS_STALE} días. Ej: "${nombreEj}" lleva ${diasEj} días sin cambio — con inflación del 4% mensual el precio real puede estar desfasado.`,
    accion:    'Revisá los precios en el Catálogo y actualizá los que correspondan.',
    datos:     { total_stale: stale.length, productos: stale.slice(0, 5) },
  };
}

module.exports = { cruzarCatalogoConTicket, detectarPreciosDesactualizados, señalPreciosDesactualizados };
