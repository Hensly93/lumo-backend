// backend/src/geo_utils.js
// Utilidades geográficas para cálculos de distancia

/**
 * Genera fragmento SQL para calcular distancia en km usando Haversine
 * @param {string} lat1 - Placeholder o columna para latitud origen
 * @param {string} lon1 - Placeholder o columna para longitud origen
 * @param {string} lat2 - Placeholder o columna para latitud destino
 * @param {string} lon2 - Placeholder o columna para longitud destino
 * @returns {string} Fragmento SQL que calcula distancia en km
 */
function fragmentoDistanciaSQL(lat1, lon1, lat2, lon2) {
  return `(
    6371 * acos(
      LEAST(1.0, GREATEST(-1.0,
        cos(radians(${lat1})) * cos(radians(${lat2})) *
        cos(radians(${lon2}) - radians(${lon1})) +
        sin(radians(${lat1})) * sin(radians(${lat2}))
      ))
    )
  )`;
}

module.exports = { fragmentoDistanciaSQL };
