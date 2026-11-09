require("dotenv").config();

// Debug: listar TODAS las variables de entorno que contengan "ANTHROPIC"
console.log('=== DEBUG: Variables de entorno con ANTHROPIC al arrancar el servidor ===');
const anthropicVars = Object.keys(process.env).filter(k => k.toUpperCase().includes('ANTHROPIC'));
if (anthropicVars.length === 0) {
  console.log('❌ NO se encontró ninguna variable que contenga "ANTHROPIC"');
} else {
  anthropicVars.forEach(k => console.log('Variable encontrada:', JSON.stringify(k)));
}
console.log('=== FIN DEBUG ===');

const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors({
  origin: [
    "https://lumo-psi.vercel.app",
    "http://localhost:3000",
  ],
  credentials: true,
}));
app.use(express.json());
app.use(require('./normalizar_respuesta')); // mensajes/recomendaciones como objeto → texto (evita pantalla blanca)

try {
  const authRoutes = require("./auth");
  app.use("/api/auth", authRoutes);
  console.log("Auth OK");
} catch(e) {
  console.error("Auth ERROR:", e.message);
}

try {
  const planRoutes = require("./routes_plan");
  app.use("/api/plan", require("./routes_plan_estado"));
  app.use("/api/plan", planRoutes);
  console.log("Plan OK");
} catch(e) {
  console.error("Plan ERROR:", e.message);
}

try {
  const pasosRoutes = require("./routes_pasos");
  app.use("/api/pasos", pasosRoutes);
  console.log("Pasos OK");
} catch(e) {
  console.error("Pasos ERROR:", e.message);
}

try {
  const negocioRoutes = require("./routes_negocio");
  app.use("/api/negocio", negocioRoutes);
  console.log("Negocio OK");
} catch(e) {
  console.error("Negocio ERROR:", e.message);
}

try {
  const dataQualityRoutes = require("./routes_data_quality");
  app.use("/api/negocio", dataQualityRoutes);
  console.log("Data Quality OK");
} catch(e) {
  console.error("Data Quality ERROR:", e.message);
}

try {
  const analisisRoutes = require("./routes_analisis");
  app.use("/api", analisisRoutes);
  console.log("Analisis OK");
} catch(e) {
  console.error("Analisis ERROR:", e.message);
}

try {
  const { correrSyncMP } = require("./mp_sync");
  app.post("/api/job/sync-mp", async (req, res) => {
    // Misma clave que el Vigilante (VIGILANTE_KEY; si no existe, INTERNAL_KEY)
    const claveEsperada = String(process.env.VIGILANTE_KEY || process.env.INTERNAL_KEY || '').trim();
    const claveRecibida = String(req.headers['x-internal-key'] || '').trim();
    if (!claveEsperada || claveRecibida !== claveEsperada) {
      return res.status(401).json({ error: 'No autorizado' });
    }
    try { res.json(await correrSyncMP()); } catch(e) { res.status(500).json({ error: e.message }); }
  });
  console.log("Sync MP OK");
} catch(e) {
  console.error("Sync MP ERROR:", e.message);
}

try {
  const fugasRoutes = require("./routes_fugas");
  app.use("/api/fugas", fugasRoutes);
  console.log("Fugas OK");
} catch(e) {
  console.error("Fugas ERROR:", e.message);
}

try {
  const mpRoutes = require("./routes_mp");
  app.use("/api/mp", mpRoutes);
  console.log("MP OAuth OK");
} catch(e) {
  console.error("MP OAuth ERROR:", e.message);
}

try {
  const cajaRoutes = require("./routes_caja");
  app.use("/api/caja", cajaRoutes);
  console.log("Caja OK");
} catch(e) {
  console.error("Caja ERROR:", e.message);
}

try {
  const multilocalRoutes = require("./routes_multilocal");
  app.use("/api/multilocal", multilocalRoutes);
  console.log("Multilocal OK");
} catch(e) {
  console.error("Multilocal ERROR:", e.message);
}

try {
  const geoRoutes = require("./routes_geo");
  app.use("/api/geo", geoRoutes);
  console.log("Geo OK");
} catch(e) {
  console.error("Geo ERROR:", e.message);
}

try {
  const usuarioRoutes = require("./routes_usuario");
  app.use("/api/usuario", usuarioRoutes);
  console.log("Usuario OK");
} catch(e) {
  console.error("Usuario ERROR:", e.message);
}

try {
  const productosRoutes = require("./routes_productos");
  app.use("/api/productos", productosRoutes);
  console.log("Productos OK");
} catch(e) {
  console.error("Productos ERROR:", e.message);
}

try {
  const scannerRoutes = require("./routes_scanner");
  app.use("/api/scanner", scannerRoutes);
  console.log("Scanner OK");
} catch(e) {
  console.error("Scanner ERROR:", e.message);
}

try {
  const scannerDuenoRoutes = require("./routes_scanner_dueno");
  app.use("/api/scanner-dueno", scannerDuenoRoutes);
  console.log("Scanner Dueno OK");
} catch(e) {
  console.error("Scanner Dueno ERROR:", e.message);
}

try {
  const historialRoutes = require("./routes_historial");
  app.use("/api/historial", historialRoutes);
  console.log("Historial OK");
} catch(e) {
  console.error("Historial ERROR:", e.message);
}

try {
  const sociosRoutes = require("./routes_socios");
  app.use("/api/socios", sociosRoutes);
  console.log("Socios OK");
} catch(e) {
  console.error("Socios ERROR:", e.message);
}

try {
  const { triggerManual } = require("./job_nocturno");
  app.post("/api/job/trigger", async (req, res) => {
    if (!process.env.INTERNAL_KEY || req.headers['x-internal-key'] !== process.env.INTERNAL_KEY) {
      return res.status(401).json({ error: 'No autorizado' });
    }
    try {
      const resultado = await triggerManual();
      res.json(resultado);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
  console.log("Job nocturno OK");
} catch(e) {
  console.error("Job nocturno ERROR:", e.message);
}

try {
  const { correrVigilante } = require("./vigilante");
  // Lo llama un servicio externo cada hora. ?dry=1 solo muestra que avisaria (no envia nada);
  // con dry=1 tambien se puede simular la hora: ?dry=1&ahora=2026-11-06T15:00:00-03:00
  app.post("/api/job/vigilante", async (req, res) => {
    // Variable propia del Vigilante (VIGILANTE_KEY); si no existe, usa INTERNAL_KEY como antes
    const claveEsperada = String(process.env.VIGILANTE_KEY || process.env.INTERNAL_KEY || '').trim();
    const claveRecibida = String(req.headers['x-internal-key'] || '').trim();
    if (!claveEsperada || claveRecibida !== claveEsperada) {
      // Solo largos, nunca la clave: sirve para ver en el log de Render si hay un espacio o caracteres de mas
      console.error('[VIGILANTE] clave rechazada: recibida de', claveRecibida.length, 'caracteres, esperada de', claveEsperada.length);
      return res.status(401).json({ error: 'No autorizado' });
    }
    try {
      const dry = req.query.dry === '1';
      const opts = { dry };
      if (dry && req.query.ahora) {
        const d = new Date(req.query.ahora);
        if (!isNaN(d.getTime())) opts.ahora = d;
      }
      res.json(await correrVigilante(undefined, opts));
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
  console.log("Vigilante OK");
} catch(e) {
  console.error("Vigilante ERROR:", e.message);
}

app.get("/api/health", (req, res) => res.json({ status: "ok", app: "Lumo", version: "2.0" }));
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Lumo backend corriendo en puerto " + PORT));