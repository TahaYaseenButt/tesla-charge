import express from "express";
import http from "http";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { ocppServer } from "./ocpp/OCPPServer.js";
import { apiRouter } from "./routes/api.js";
import { initDatabase } from "./database/db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize SQLite Database schema
initDatabase();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// API Routes
app.use("/api", apiRouter);

// Monitor Route: Server Hardware, Load, RAM, CPU Telemetry
app.get("/monitor", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "monitor.html"));
});

// Fallback to dashboard
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Create HTTP server
const server = http.createServer(app);

// Attach OCPP 1.6-J WebSocket Server
ocppServer.attach(server);

// Start Server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`====================================================`);
  console.log(`⚡ T-Charge Standalone OCPP 1.6-J Server is RUNNING!`);
  console.log(`📡 Local Port:         http://0.0.0.0:${PORT}`);
  console.log(`🌐 Dashboard:          http://localhost:${PORT}`);
  console.log(`🔌 Internet OCPP URL:  wss://tesla-charge.online/api/ocpp/version/1.6`);
  console.log(`🔌 Local LAN OCPP URL: ws://192.168.0.131:${PORT}/api/ocpp/version/1.6`);
  console.log(`💾 Local Database:     SQLite (WAL Mode) - data/tcharge.db`);
  console.log(`🚀 Mode:               Direct Self-Hosted (Zero Cloud/Firebase)`);
  console.log(`====================================================`);
});

// Graceful Shutdown
const handleShutdown = (signal) => {
  console.log(`\n[Server] Caught ${signal}, starting graceful shutdown...`);
  server.close(() => {
    console.log("[Server] HTTP and WebSocket listeners closed cleanly.");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("[Server] Forced exit after timeout.");
    process.exit(0);
  }, 5000);
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
