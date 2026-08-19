// routes_geo.js — Endpoint de búsqueda de localidades vía Georef API
// GET /api/geo/localidades?provincia_id=06&q=san

const express = require('express');
const router = express.Router();

const GEOREF_URL = 'https://apis.datos.gob.ar/georef/api/localidades';
const TIMEOUT_MS = 5000;

// ─── GET /api/geo/localidades ────────────────────────────────────────────────
// Búsqueda de localidades por provincia y texto
// Query params: provincia_id (requerido), q (texto de búsqueda, requerido)
// Retorna: array de {id, nombre} o [] si falla
router.get('/localidades', async (req, res) => {
  try {
    const { provincia_id, q } = req.query;

    // Validar parámetros requeridos
    if (!provincia_id) {
      return res.status(400).json({
        error: 'provincia_id es requerido'
      });
    }

    if (!q) {
      return res.status(400).json({
        error: 'q (texto de búsqueda) es requerido'
      });
    }

    // Construir parámetros para Georef
    const params = new URLSearchParams({
      provincia: provincia_id,
      nombre: q,
      campos: 'id,nombre',
      max: '15'
    });

    // Timeout de 5 segundos
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(`${GEOREF_URL}?${params}`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`Georef HTTP error: ${response.status}`);
      return res.json([]); // Devolver array vacío en caso de error
    }

    const data = await response.json();

    // Extraer solo el array de localidades del objeto de respuesta de Georef
    // Georef devuelve {cantidad, inicio, total, parametros, localidades: [...]}
    // Solo necesitamos el array localidades
    if (data && Array.isArray(data.localidades)) {
      return res.json(data.localidades);
    }

    // Si la estructura es inesperada, devolver array vacío
    return res.json([]);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Georef timeout después de 5 segundos');
    } else {
      console.error('Error en búsqueda de localidades:', error.message);
    }
    // En caso de error, devolver array vacío (es un autocompletar)
    return res.json([]);
  }
});

module.exports = router;
