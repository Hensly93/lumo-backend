const pool = require('./db');
const { fragmentoDistanciaSQL } = require('./geo_utils');
const { resolverCoordenadasSucursal } = require('./zscore_contextual');

const RADIOS_KM = [5, 15, 30, 50];
const CONFIANZA_POR_RADIO = { 5: 95, 15: 80, 30: 65, 50: 50 };
const MIN_NEGOCIOS_CAPA1 = 15;
const MIN_PRODUCTOS_REPRECIADOS = 5;
const TOPE_PORCENTAJE_CATALOGO = 0.15;

function calcularPesosInflacion(cantidadRepreciados, catalogoTotal) {
  if (cantidadRepreciados < MIN_PRODUCTOS_REPRECIADOS || catalogoTotal === 0) {
    return { peso_capa1: 1, peso_capa2: 0 };
  }
  const pct = cantidadRepreciados / catalogoTotal;
  const peso_capa2 = Math.min(pct / TOPE_PORCENTAJE_CATALOGO, 1.0);
  return { peso_capa1: 1 - peso_capa2, peso_capa2 };
}

async function calcularCapa2(negocioId, fecha) {
  const r = await pool.query(
    `SELECT AVG((precio_nuevo - precio_anterior) / precio_anterior * 100) as indice,
            COUNT(DISTINCT producto_id) as cantidad
     FROM productos_historico_precios
     WHERE negocio_id=$1 AND precio_anterior IS NOT NULL AND precio_anterior > 0
       AND DATE_TRUNC('month', fecha_cambio) = DATE_TRUNC('month', $2::date)`,
    [negocioId, fecha]
  );
  const cantidad = parseInt(r.rows[0].cantidad);
  if (cantidad === 0) return { indice: null, cantidad: 0 };
  return { indice: parseFloat(r.rows[0].indice), cantidad };
}

async function calcularCapa1(negocioId, tipoNegocio, fecha) {
  if (!tipoNegocio) return { indice: null, motivo: 'sin_tipo_negocio' };

  const coords = await resolverCoordenadasSucursal(negocioId, null);
  if (!coords) return { indice: null, motivo: 'sin_geocoding' };

  const distSQL = fragmentoDistanciaSQL('$1', '$2', 'sp.latitud', 'sp.longitud');

  for (const radio of RADIOS_KM) {
    const r = await pool.query(
      `WITH sucursal_principal AS (
         SELECT DISTINCT ON (negocio_id) negocio_id, latitud, longitud
         FROM mis_sucursales WHERE geocoding_status='ok'
         ORDER BY negocio_id, id ASC
       ),
       candidatos AS (
         SELECT n.id as negocio_id, ${distSQL} as distancia_km
         FROM negocios n
         JOIN sucursal_principal sp ON sp.negocio_id = n.id
         WHERE n.tipo_negocio=$3 AND n.id != $4
       )
       SELECT c.negocio_id,
              AVG((phc.precio_nuevo - phc.precio_anterior) / phc.precio_anterior * 100) as cambio_negocio
       FROM candidatos c
       JOIN productos_historico_precios phc ON phc.negocio_id = c.negocio_id
       WHERE phc.precio_anterior IS NOT NULL AND phc.precio_anterior > 0
         AND DATE_TRUNC('month', phc.fecha_cambio) = DATE_TRUNC('month', $5::date)
         AND c.distancia_km <= $6
       GROUP BY c.negocio_id`,
      [coords.lat, coords.lon, tipoNegocio, negocioId, fecha, radio]
    );

    if (r.rows.length >= MIN_NEGOCIOS_CAPA1) {
      const promedios = r.rows.map(row => parseFloat(row.cambio_negocio));
      const indice = promedios.reduce((a, b) => a + b, 0) / promedios.length;
      return {
        indice,
        negocios_encontrados: r.rows.length,
        radio_usado_km: radio,
        confianza: CONFIANZA_POR_RADIO[radio],
      };
    }
  }

  return { indice: null, motivo: 'sin_datos_suficientes_en_radio_maximo' };
}

async function calcularIndiceInflacion(negocioId, tipoNegocio, fecha = new Date()) {
  const catalogoRes = await pool.query(
    'SELECT COUNT(*) as total FROM productos WHERE negocio_id=$1 AND activo=true',
    [negocioId]
  );
  const catalogoTotal = parseInt(catalogoRes.rows[0].total);

  const [capa2, capa1] = await Promise.all([
    calcularCapa2(negocioId, fecha),
    calcularCapa1(negocioId, tipoNegocio, fecha),
  ]);

  let { peso_capa1, peso_capa2 } = calcularPesosInflacion(capa2.cantidad, catalogoTotal);

  if (capa1.indice !== null && capa1.confianza) {
    // Ajustar peso_capa1 por confianza del radio usado
    peso_capa1 = peso_capa1 * (capa1.confianza / 100);
    peso_capa2 = 1 - peso_capa1;
  } else {
    peso_capa1 = 0;
    peso_capa2 = 1;
  }

  if (capa2.indice === null && capa1.indice === null) {
    return { disponible: false, motivo: 'sin_datos_ninguna_capa' };
  }

  // Validar muestra suficiente cuando Capa2 es la única fuente
  if (peso_capa2 === 1 && capa2.cantidad < MIN_PRODUCTOS_REPRECIADOS) {
    return { disponible: false, motivo: 'datos_insuficientes_capa2_sola' };
  }

  const indice_final =
    (capa1.indice ?? 0) * peso_capa1 + (capa2.indice ?? 0) * peso_capa2;

  return {
    disponible: true,
    indice_mensual: Math.round(indice_final * 100) / 100,
    capa1,
    capa2,
    pesos: { capa1: Math.round(peso_capa1 * 100), capa2: Math.round(peso_capa2 * 100) },
  };
}

module.exports = { calcularPesosInflacion, calcularCapa1, calcularCapa2, calcularIndiceInflacion };
