// geocoding.js — Módulo de geolocalización de direcciones usando Nominatim (OpenStreetMap)
// Convierte direcciones estructuradas en coordenadas lat/lon

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const TIMEOUT_MS = 5000;
const USER_AGENT = 'Lumo/1.0 (contacto: castellyholy@gmail.com)';

/**
 * Geocodifica una dirección estructurada usando Nominatim
 * @param {string} calle - Nombre de la calle
 * @param {string} numero - Número de calle
 * @param {string} localidad - Ciudad o localidad
 * @param {string} provincia - Provincia
 * @returns {Promise<{lat: string, lon: string, status: 'ok'} | {status: 'error'}>}
 */
async function geocodificarDireccion(calle, numero, localidad, provincia) {
  try {
    // Construir parámetros de búsqueda estructurados
    const params = new URLSearchParams({
      street: numero && calle ? `${numero} ${calle}` : calle || '',
      city: localidad || '',
      state: provincia || '',
      country: 'Argentina',
      format: 'json',
      limit: '1',
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: {
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`Nominatim HTTP error: ${response.status}`);
      return { status: 'error' };
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      console.log('Nominatim: no se encontraron resultados para la dirección');
      return { status: 'error' };
    }

    const result = data[0];
    return {
      lat: parseFloat(result.lat),
      lon: parseFloat(result.lon),
      status: 'ok',
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Geocoding timeout después de 5 segundos');
    } else {
      console.error('Error en geocodificarDireccion:', error.message);
    }
    return { status: 'error' };
  }
}

module.exports = { geocodificarDireccion };
