import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { getKarachiIso } from "../utils/time.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DIAGNOSTICS_DIR = path.join(__dirname, "..", "public", "diagnostics");

// Ensure diagnostics directory exists
if (!fs.existsSync(DIAGNOSTICS_DIR)) {
  fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
}

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Automatically attempts to list or extract text previews from a .tar.bz2 / .tar.gz / .log file
 */
export async function inspectDiagnosticArchive(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (filePath.endsWith(".tar.bz2") || filePath.endsWith(".tbz2")) {
      const { stdout: listOut } = await execAsync(`tar -tjf "${filePath}" 2>/dev/null | head -n 50`);
      const files = listOut.split("\n").map((s) => s.trim()).filter(Boolean);
      let sampleText = "";
      if (files.length > 0) {
        try {
          const { stdout: contentOut } = await execAsync(
            `tar -xjf "${filePath}" -O 2>/dev/null | strings | tail -n 120`
          );
          sampleText = contentOut;
        } catch (_e) {}
      }
      return { files, sampleText };
    } else if (filePath.endsWith(".tar.gz") || filePath.endsWith(".tgz")) {
      const { stdout: listOut } = await execAsync(`tar -tzf "${filePath}" 2>/dev/null | head -n 50`);
      const files = listOut.split("\n").map((s) => s.trim()).filter(Boolean);
      return { files, sampleText: "" };
    } else if (ext === ".log" || ext === ".txt" || ext === ".csv") {
      const content = fs.readFileSync(filePath, "utf8").slice(-8000);
      return { files: [path.basename(filePath)], sampleText: content };
    }
  } catch (_err) {}
  return { files: [], sampleText: "" };
}

/**
 * List all diagnostic files stored in src/public/diagnostics
 */
export function listDiagnosticFiles() {
  try {
    if (!fs.existsSync(DIAGNOSTICS_DIR)) return [];
    const entries = fs.readdirSync(DIAGNOSTICS_DIR);
    const results = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const fullPath = path.join(DIAGNOSTICS_DIR, name);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        results.push({
          fileName: name,
          sizeBytes: stat.size,
          sizeKB: Number((stat.size / 1024).toFixed(2)),
          uploadedAt: getKarachiIso(stat.mtime),
          downloadUrl: `/diagnostics/${encodeURIComponent(name)}`,
        });
      }
    }
    return results.sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
  } catch (err) {
    console.error("[FTP Diagnostics] Error listing files:", err.message);
    return [];
  }
}

/**
 * Lightweight Built-In FTP Server for OCPP 1.6 GetDiagnostics
 * Supports Anonymous & Authenticated login, PASV & PORT data transfers, STOR (Upload), LIST, RETR, MKD, CWD.
 */
export function startFtpDiagnosticsServer(ocppServer) {
  const preferredPort = parseInt(process.env.FTP_PORT || "2121", 10);
  const tryPort21 = process.env.FTP_TRY_PORT_21 !== "false";

  const createFtpServer = (listenPort) => {
    const server = net.createServer((socket) => {
      let currentDir = "/";
      let dataServer = null;
      let dataSocket = null;
      let pendingDataCallback = null;

      const log = (msg) => {
        const line = `[FTP:${listenPort}] ${msg}`;
        if (ocppServer && typeof ocppServer.log === "function") {
          ocppServer.log(line);
        } else {
          console.log(line);
        }
      };

      const reply = (code, message) => {
        if (!socket.destroyed) {
          socket.write(`${code} ${message}\r\n`);
        }
      };

      const registerDataSocket = (sock) => {
        dataSocket = sock;
        if (pendingDataCallback) {
          const cb = pendingDataCallback;
          pendingDataCallback = null;
          cb(sock);
        }
      };

      const waitForDataSocket = (cb) => {
        if (dataSocket) {
          const s = dataSocket;
          dataSocket = null;
          cb(s);
        } else {
          pendingDataCallback = cb;
        }
      };

      log(`Incoming FTP connection from ${socket.remoteAddress}`);
      reply(220, "Tesla-Charge OCPP Diagnostics FTP Server Ready");

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;

          const spaceIdx = line.indexOf(" ");
          const cmd = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toUpperCase();
          const arg = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();
          log(`<- ${cmd} ${arg}`);

          switch (cmd) {
            case "USER":
              reply(331, "User name okay, need password (or anonymous).");
              break;
            case "PASS":
            case "ACCT":
              reply(230, "User logged in, proceed.");
              break;
            case "SYST":
              reply(215, "UNIX Type: L8");
              break;
            case "FEAT":
              socket.write("211-Features:\r\n EPSV\r\n PASV\r\n UTF8\r\n SIZE\r\n211 End\r\n");
              break;
            case "OPTS":
              reply(200, "OPTS OK");
              break;
            case "PWD":
            case "XPWD":
              reply(257, `"${currentDir}" is current directory.`);
              break;
            case "CWD":
            case "XCWD":
              currentDir = arg.startsWith("/") ? arg : `/${arg}`;
              reply(250, `Directory changed to ${currentDir}`);
              break;
            case "CDUP":
            case "XCUP":
              currentDir = "/";
              reply(250, "Directory changed to /");
              break;
            case "MKD":
            case "XMKD":
              reply(257, `"${arg}" directory created.`);
              break;
            case "TYPE":
              reply(200, `Type set to ${arg || "I"}`);
              break;
            case "MODE":
            case "STRU":
            case "NOOP":
            case "ALLO":
            case "REIN":
              reply(200, "OK");
              break;
            case "EPSV": {
              if (dataServer) {
                try { dataServer.close(); } catch (_e) {}
              }
              dataServer = net.createServer((dSock) => {
                registerDataSocket(dSock);
              });
              dataServer.listen(0, "0.0.0.0", () => {
                const port = dataServer.address().port;
                log(`-> 229 Entering Extended Passive Mode (|||${port}|)`);
                reply(229, `Entering Extended Passive Mode (|||${port}|)`);
              });
              break;
            }
            case "PASV": {
              if (dataServer) {
                try { dataServer.close(); } catch (_e) {}
              }
              dataServer = net.createServer((dSock) => {
                registerDataSocket(dSock);
              });
              dataServer.listen(0, "0.0.0.0", () => {
                const port = dataServer.address().port;
                const localIp = (socket.localAddress || "").replace(/^::ffff:/, "");
                const ip =
                  process.env.FTP_PASV_IP ||
                  (localIp && localIp !== "127.0.0.1" && localIp !== "::1" && localIp !== "0.0.0.0"
                    ? localIp
                    : getLocalLanIp());
                const ipParts = ip.split(".").map((n) => parseInt(n, 10) || 0);
                const p1 = (port >> 8) & 0xff;
                const p2 = port & 0xff;
                log(`-> 227 Entering Passive Mode (${ipParts[0]},${ipParts[1]},${ipParts[2]},${ipParts[3]},${p1},${p2})`);
                reply(227, `Entering Passive Mode (${ipParts[0]},${ipParts[1]},${ipParts[2]},${ipParts[3]},${p1},${p2})`);
              });
              break;
            }
            case "PORT": {
              const parts = arg.split(",").map((n) => parseInt(n, 10));
              if (parts.length === 6) {
                const host = parts.slice(0, 4).join(".");
                const port = (parts[4] << 8) + parts[5];
                const outbound = net.createConnection({ host, port }, () => {
                  registerDataSocket(outbound);
                });
                outbound.on("error", (err) => log(`Active PORT error: ${err.message}`));
                reply(200, "PORT command successful.");
              } else {
                reply(501, "Syntax error in parameters");
              }
              break;
            }
            case "LIST":
            case "NLST": {
              reply(150, "Opening data connection for directory list.");
              waitForDataSocket((dSock) => {
                const files = listDiagnosticFiles();
                const listStr = files
                  .map((f) => `-rw-r--r-- 1 ftp ftp ${f.sizeBytes} Jan 01 00:00 ${f.fileName}\r\n`)
                  .join("");
                dSock.end(listStr, () => {
                  reply(226, "Transfer complete.");
                });
              });
              break;
            }
            case "STOR":
            case "APPE": {
              const safeName = path.basename(arg || `diag_${Date.now()}.tar.bz2`).replace(/[^a-zA-Z0-9._-]/g, "_");
              const destPath = path.join(DIAGNOSTICS_DIR, safeName);
              log(`Receiving diagnostic file via FTP: ${safeName}...`);
              reply(150, "Opening binary mode data connection for file upload.");
              waitForDataSocket((dSock) => {
                const writeStream = fs.createWriteStream(destPath);
                let bytesReceived = 0;
                dSock.on("data", (chunk) => {
                  bytesReceived += chunk.length;
                });
                dSock.pipe(writeStream);
                writeStream.on("finish", () => {
                  log(`✅ Diagnostic file upload complete: ${safeName} (${bytesReceived} bytes)`);
                  reply(226, "Transfer complete.");
                });
                writeStream.on("error", (err) => {
                  log(`❌ Error writing diagnostic file ${safeName}: ${err.message}`);
                  reply(550, "File write error.");
                });
              });
              break;
            }
            case "SIZE": {
              const safeName = path.basename(arg || "");
              const fullPath = path.join(DIAGNOSTICS_DIR, safeName);
              if (fs.existsSync(fullPath)) {
                reply(213, String(fs.statSync(fullPath).size));
              } else {
                reply(213, "0");
              }
              break;
            }
            case "QUIT":
              reply(221, "Goodbye.");
              socket.end();
              break;
            default:
              reply(502, "Command not implemented.");
              break;
          }
        }
      });

      socket.on("close", () => {
        if (dataServer) {
          try { dataServer.close(); } catch (_e) {}
        }
      });
      socket.on("error", () => {});
    });

    server.on("error", (err) => {
      if (listenPort === 21 && (err.code === "EACCES" || err.code === "EADDRINUSE")) {
        // Expected on non-root macOS/Linux when binding port 21; port 2121 will still run
        return;
      }
      console.warn(`[FTP Diagnostics] Port ${listenPort} notice: ${err.message}`);
    });

    server.listen(listenPort, "0.0.0.0", () => {
      const ip = getLocalLanIp();
      console.log(`📂 FTP Diagnostics Receiver listening on ftp://${ip}:${listenPort}/ (Anonymous login enabled)`);
    });
  };

  createFtpServer(preferredPort);
  if (tryPort21 && preferredPort !== 21) {
    createFtpServer(21);
  }
}

