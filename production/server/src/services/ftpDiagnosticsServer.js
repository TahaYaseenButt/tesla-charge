import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import dns from "dns";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { getKarachiIso } from "../utils/time.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DIAGNOSTICS_DIR = path.join(__dirname, "..", "public", "diagnostics");

export const publicFtpState = {
  ctrlHost: null,
  ctrlIp: null,
  ctrlPort: null,
  dataHost: null,
  dataIp: null,
  dataPort: null,
  ftpUrl: null,
  ftpIpUrl: null,
  updatedAt: null,
};

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

function isPrivateIp(ip = "") {
  const clean = String(ip).replace(/^::ffff:/, "");
  return (
    clean === "::1" ||
    clean.startsWith("127.") ||
    clean.startsWith("10.") ||
    clean.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(clean)
  );
}

// Public WAN IP used in PASV replies for chargers connecting from the internet (4G etc.)
let detectedPublicIp = process.env.FTP_PASV_IP || null;
async function detectPublicIp() {
  if (process.env.FTP_PASV_IP) return;
  try {
    const res = await fetch("https://api.ipify.org");
    const ip = (await res.text()).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) detectedPublicIp = ip;
  } catch (_e) {}
}
export function getPublicFtpUrl() {
  if (process.env.FTP_PUBLIC_URL) return process.env.FTP_PUBLIC_URL;
  if (detectedPublicIp) return `ftp://anonymous:anonymous@${detectedPublicIp}/`;
  return null;
}

/**
 * Automatically attempts to list or extract text previews from a .tar.bz2 / .tar.gz / .log file.
 * If subfile is specified, extracts and returns that specific file inside the archive.
 */
export async function inspectDiagnosticArchive(filePath, subfile = null) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const isTarBz2 = filePath.endsWith(".tar.bz2") || filePath.endsWith(".tbz2");
    const isTarGz = filePath.endsWith(".tar.gz") || filePath.endsWith(".tgz");

    if (isTarBz2 || isTarGz) {
      const listFlag = isTarBz2 ? "-tjf" : "-tzf";
      const extractFlag = isTarBz2 ? "-xjf" : "-xzf";
      const { stdout: listOut } = await execAsync(`tar ${listFlag} "${filePath}" 2>/dev/null`);
      const files = listOut
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && !s.endsWith("/"));

      let content = "";
      const target =
        subfile ||
        files.find((f) => f === "ccs_evse.log") ||
        files.find((f) => f.endsWith(".log") || f.endsWith(".txt")) ||
        files[0];
      if (target) {
        try {
          const { stdout: fileContent } = await execAsync(
            `tar ${extractFlag} "${filePath}" -O "${target}" 2>/dev/null | head -n 10000`
          );
          content = fileContent;
        } catch (_e) {}
      }
      return { files, currentFile: target, content };
    } else if (ext === ".log" || ext === ".txt" || ext === ".csv") {
      const content = fs.readFileSync(filePath, "utf8").slice(-150000);
      return { files: [path.basename(filePath)], currentFile: path.basename(filePath), content };
    }
  } catch (_err) {}
  return { files: [], currentFile: null, content: "" };
}

/**
 * Actively syncs diagnostic log files from remote FTP (e.g. InfinityFree / public FTP) into DIAGNOSTICS_DIR
 */
export async function syncRemoteFtpFiles() {
  const ftpUrl = process.env.FTP_PUBLIC_URL;
  if (!ftpUrl) {
    return { success: false, error: "No FTP_PUBLIC_URL configured in .env" };
  }

  try {
    const parsed = new URL(ftpUrl);
    const user = decodeURIComponent(parsed.username || "");
    const pass = decodeURIComponent(parsed.password || "");
    const host = parsed.hostname;
    const port = parsed.port || "21";
    const remotePath = (parsed.pathname || "/htdocs/").replace(/^\/|\/$/g, "");

    const pyScript = `
import ftplib, os, sys
try:
    ftp = ftplib.FTP(timeout=20)
    ftp.connect("${host}", int("${port}"))
    ftp.login("${user}", "${pass}")
    path = "${remotePath}"
    if path:
        ftp.cwd(path)
    files = []
    ftp.retrlines("NLST", files.append)
    dest_dir = "${DIAGNOSTICS_DIR}"
    os.makedirs(dest_dir, exist_ok=True)
    synced = []
    for f in files:
        if f.endswith((".tar.bz2", ".tbz2", ".tar.gz", ".tgz", ".log", ".txt")):
            dest = os.path.join(dest_dir, f)
            if not os.path.exists(dest) or os.path.getsize(dest) == 0:
                with open(dest, "wb") as lf:
                    ftp.retrbinary(f"RETR {f}", lf.write)
                synced.append(f)
    ftp.quit()
    print("SYNCED:" + ",".join(synced))
except Exception as e:
    print("ERROR:" + str(e), file=sys.stderr)
    sys.exit(1)
`;

    const { stdout, stderr } = await execAsync(
      `python3 -c '${pyScript.replace(/'/g, "'\\''")}'`,
      { timeout: 35000 }
    );
    const syncedLine = stdout.split("\n").find((l) => l.startsWith("SYNCED:"));
    const syncedFiles = syncedLine
      ? syncedLine.replace("SYNCED:", "").split(",").filter(Boolean)
      : [];

    return {
      success: true,
      syncedCount: syncedFiles.length,
      syncedFiles,
      message: syncedFiles.length ? `Downloaded ${syncedFiles.length} file(s)` : "Up to date",
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
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
  const preferredPasvPort = parseInt(process.env.FTP_PASV_PORT || "2122", 10);
  const tryPort21 = process.env.FTP_TRY_PORT_21 !== "false";

  let activeDataSocketHandler = null;

  // Persistent shared Passive Data Server on port 2122 so SSH tunnel & NAT forwards never hit a closed port
  const sharedPasvServer = net.createServer((dSock) => {
    if (activeDataSocketHandler) {
      activeDataSocketHandler(dSock);
    } else {
      dSock.destroy();
    }
  });
  sharedPasvServer.on("error", (err) => {
    console.warn(`[FTP Diagnostics] Shared PASV port ${preferredPasvPort} notice: ${err.message}`);
  });
  sharedPasvServer.listen(preferredPasvPort, "0.0.0.0", () => {
    console.log(`📂 FTP Passive Data Listener ready on port ${preferredPasvPort}`);
  });

  const createFtpServer = (listenPort) => {
    const server = net.createServer((socket) => {
      let currentDir = "/";
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

      activeDataSocketHandler = registerDataSocket;

      const waitForDataSocket = (cb) => {
        if (dataSocket) {
          const s = dataSocket;
          dataSocket = null;
          cb(s);
        } else {
          pendingDataCallback = cb;
        }
      };

      const isTunnelConn =
        (socket.remoteAddress || "").includes("127.0.0.1") ||
        (socket.remoteAddress || "") === "::1";

      log(`Incoming FTP connection from ${socket.remoteAddress} (tunnel=${isTunnelConn})`);
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
              activeDataSocketHandler = registerDataSocket;
              const pasvPort = isTunnelConn && publicFtpState.dataPort ? publicFtpState.dataPort : preferredPasvPort;
              log(`-> 229 Entering Extended Passive Mode (|||${pasvPort}|)`);
              reply(229, `Entering Extended Passive Mode (|||${pasvPort}|)`);
              break;
            }
            case "PASV": {
              activeDataSocketHandler = registerDataSocket;
              const pasvPort = isTunnelConn && publicFtpState.dataPort ? publicFtpState.dataPort : preferredPasvPort;
              const localIp = (socket.localAddress || "").replace(/^::ffff:/, "");
              const clientIsPublic = !isPrivateIp(socket.remoteAddress);
              const ip =
                (isTunnelConn && publicFtpState.dataIp) ||
                (clientIsPublic && detectedPublicIp) ||
                (localIp && localIp !== "127.0.0.1" && localIp !== "::1" && localIp !== "0.0.0.0"
                  ? localIp
                  : getLocalLanIp());
              const ipParts = ip.split(".").map((n) => parseInt(n, 10) || 0);
              const p1 = (pasvPort >> 8) & 0xff;
              const p2 = pasvPort & 0xff;
              log(`-> 227 Entering Passive Mode (${ipParts[0]},${ipParts[1]},${ipParts[2]},${ipParts[3]},${p1},${p2})`);
              reply(227, `Entering Passive Mode (${ipParts[0]},${ipParts[1]},${ipParts[2]},${ipParts[3]},${p1},${p2})`);
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

      socket.on("close", () => {});
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

  // Launch persistent Public Internet TCP Tunnels for worldwide 4G chargers (Control 2121 + Passive Data 2122)
  const spawnTunnel = (localPort, role) => {
    const start = () => {
      const proc = spawn(
        "ssh",
        [
          "-p",
          "443",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "ServerAliveInterval=25",
          "-o",
          "ExitOnForwardFailure=yes",
          "-T",
          `-R0:localhost:${localPort}`,
          "tcp@a.pinggy.io",
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );

      let buf = "";
      proc.stdout.on("data", async (chunk) => {
        buf += chunk.toString("utf8");
        const m = buf.match(/tcp:\/\/([^:\s]+):(\d+)/);
        if (m) {
          const host = m[1];
          const port = parseInt(m[2], 10);
          buf = "";
          let ip = host;
          try {
            const res = await dns.promises.lookup(host, { family: 4 });
            if (res && res.address) ip = res.address;
          } catch (_e) {}

          if (role === "ctrl") {
            publicFtpState.ctrlHost = host;
            publicFtpState.ctrlIp = ip;
            publicFtpState.ctrlPort = port;
            publicFtpState.ftpUrl = `ftp://anonymous:anonymous@${host}:${port}/`;
            publicFtpState.ftpIpUrl = `ftp://${ip}:${port}/`;
            publicFtpState.updatedAt = getKarachiIso();
            console.log(`🌍 Worldwide FTP Control Tunnel ready: ${publicFtpState.ftpUrl} (${publicFtpState.ftpIpUrl})`);
          } else {
            publicFtpState.dataHost = host;
            publicFtpState.dataIp = ip;
            publicFtpState.dataPort = port;
            publicFtpState.updatedAt = getKarachiIso();
            console.log(`🌍 Worldwide FTP Passive Data Tunnel ready: ${ip}:${port} -> localhost:${localPort}`);
          }
        }
      });

      proc.on("close", () => {
        setTimeout(start, 5000);
      });
      proc.on("error", () => {});
    };
    start();
  };

  detectPublicIp().then(() => {
    console.log(`🌍 FTP public URL for worldwide chargers: ${getPublicFtpUrl() || "(unknown)"} (router must forward TCP 21->2121 and 2122->2122)`);
  });

  // Optional temporary tunnels (expire after 60 min, random ports) - opt-in only
  if (process.env.FTP_PUBLIC_TUNNEL === "true") {
    spawnTunnel(preferredPort, "ctrl");
    spawnTunnel(preferredPasvPort, "data");
  }
}

