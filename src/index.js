require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

try {
  const authRoutes = require("./auth");
  app.use("/api/auth", authRoutes);
  console.log("Auth OK");
} catch(e) {
  console.error("Auth ERROR:", e.message);
}

app.get("/api/health", (req, res) => res.json({ status: "ok", app: "Lumo" }));
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Lumo backend corriendo en puerto " + PORT));