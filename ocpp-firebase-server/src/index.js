import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { ocppServer } from "./ocpp/OCPPServer.js";
import { apiRouter } from "./routes/paymentWebhook.js";
import { startCommandListener } from "./services/commandListener.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
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

// Start listening for remote commands from the React Mobile App via Firestore
startCommandListener();

// Start Server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`====================================================`);
  console.log(`⚡ T-Charge OCPP 1.6-J Firebase Server is RUNNING!`);
  console.log(`📡 Local Port:         http://0.0.0.0:${PORT}`);
  console.log(`🌐 Dashboard:          http://localhost:${PORT}`);
  console.log(`🔌 Charger OCPP URL:   ws://tesla-charge.online:${PORT}/api/ocpp/version/1.6`);
  console.log(`🔥 Firebase Project:   fir-85543`);
  console.log(`====================================================`);
});

// Graceful Docker / OS Shutdown
const handleShutdown = (signal) => {
  console.log(`\n[Server] Caught ${signal}, starting graceful shutdown...`);
  server.close(() => {
    console.log("[Server] HTTP and WebSocket listeners closed cleanly.");
    process.exit(0);
  });
  // Force exit if hanging sockets don't close after 5 seconds
  setTimeout(() => {
    console.warn("[Server] Forced exit after timeout.");
    process.exit(0);
  }, 5000);
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

