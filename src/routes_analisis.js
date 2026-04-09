// routes_analisis.js — Lumo v2.0
// Endpoints de análisis del motor híbrido.

const express = require('express');
const router = express.Router();
const { analizarNegocio } = require('./motor');
const { verificarToken } = require('./auth');
const pool = require('./db');

// ─── GET /api/analisis ───────────────────────────────────────────────────────
// Análisis completo del negocio autenticado.

router.get('/analisis', verificarToken, async (req, res) => {
  try {
    const resultado = await analizarNegocio(req.usuario.id);
    res.json(resultado);
  } catch (error) {
    console.error('Error /analisis:', error.message);
    res.status(500).json({ error: 'Error al analizar el negocio' });
  }
});

// ─── GET /api/analisis/resumen ───────────────────────────────────────────────
// Resumen rápido para el Home: pérdida estimada + cantidad de alertas activas.

router.get('/analisis/resumen', verificarToken, async (req, res) => {
  try {
    const resultado = await analizarNegocio(req.usuario.id);

    const alertasCriticas = resultado.alertas?.filter(a => a.prioridad === 'critica') || [];
    const alertasAtencion = resultado.alertas?.filter(a => a.prioridad === 'atencion') || [];

    const perdidaEstimada = resultado.alertas?.reduce(
      (sum, a) => sum + (a.impacto_estimado_pesos || 0), 0
    ) || 0;

    res.json({
      perdida_estimada_pesos: perdidaEstimada,
      perdida_es_estimada: true,
      alertas_criticas: alertasCriticas.length,
      alertas_atencion: alertasAtencion.length,
      total_alertas: resultado.alertas?.length
