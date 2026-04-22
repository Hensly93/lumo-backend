require("dotenv").config();
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