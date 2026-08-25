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

try {
  const authRoutes = require("./auth");
  app.use("/api/auth", authRoutes);
  console.log("Auth OK");
} catch(e) {
  console.error("Auth ERROR:", e.message);
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
    if (req.headers['x-internal-key'] !== process.env.INTERNAL_KEY) {
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

app.get("/api/health", (req, res) => res.json({ status: "ok", app: "Lumo", version: "2.0" }));
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Lumo backend corriendo en puerto " + PORT));