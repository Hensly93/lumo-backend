// cruce_catalogo.js — Lumo S17
// Integración entre catálogo de productos y comportamiento real de ventas.
//
// cruzarCatalogoConTicket: compara ticket promedio real vs precio promedio del
// catálogo. Si divergen ≥20% → señal analítica para NICOLE.

const pool = require('./db');

const UMBRAL_DIVERGENCIA    = 0.20;  // 20% de divergencia ticket vs catálogo
const MIN_PRODUCTOS_ACTIVOS = 3;
const MIN_TX_TICKET         = 10;

// ─── 1. Cruce ticket real vs precio promedio del catálogo ─────────────────────

async function cruzarCatalogoConTicket(usuarioId, sucursalId = null) {
  const catRes = await pool.query(
    `SELECT AVG(precio_venta) AS precio_promedio, COUNT(*) AS n_productos
     FROM productos
     WHERE negocio_id=$1 AND activo=true AND precio_venta IS NOT NULL`,
    [usuarioId]
  );

  const { precio_promedio, n_productos } = catRes.rows[0];
  if (!precio_promedio || parseInt(n_productos) < MIN_PRODUCTOS_ACTIVOS) {
    return { disponible: false, motivo: 'catalogo_insuficiente' };
  }

  const txRes = await pool.query(
    `SELECT AVG(monto) AS ticket_real, COUNT(*) AS n_tx
     FROM transacciones
     WHERE negocio_id=$1
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

module.exports = { cruzarCatalogoConTicket };
