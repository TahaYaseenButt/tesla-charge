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
  console.log(`🔌 Charger OCPP URL:   ws://tcharge.duckdns.org:${PORT}/api/ocpp/version/1.6`);
  console.log(`🔥 Firebase Project:   fir-85543`);
  console.log(`====================================================`);
});
