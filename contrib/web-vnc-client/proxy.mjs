/**
 * WebSocket → TCP proxy for the Web VNC Client.
 *
 * Accepts WebSocket connections from the browser and pipes them to a plain
 * TCP VNC server, allowing the browser to reach any standard VNC server.
 *
 * Usage:
 *   node proxy.mjs [--port 8900] [--host 0.0.0.0] [--allow-origin "*"]
 *
 * The browser connects to:
 *   ws://localhost:8900?host=VNC_HOST&port=VNC_PORT
 *
 * Security note: by default only loopback origins are accepted.
 * Pass --allow-origin "*" to open to all origins (use behind a firewall).
 */

import { createConnection }            from "node:net";
import { createServer as httpServer }  from "node:http";
import { WebSocketServer }             from "ws";
import { URL }                         from "node:url";

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { port: 8900, host: "127.0.0.1", allowOrigin: null };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--port")          { out.port = Number(v); i += 1; }
    else if (k === "--host")     { out.host = v; i += 1; }
    else if (k === "--allow-origin") { out.allowOrigin = v; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// ── HTTP server (WebSocket upgrade target) ────────────────────────────────

const server = httpServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Web VNC Proxy – connect via WebSocket\n");
});

// ── WebSocket server ──────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  verifyClient({ origin }, cb) {
    if (args.allowOrigin === "*") return cb(true);
    if (!origin) return cb(true);
    let u;
    try { u = new URL(origin); } catch { return cb(false, 403, "Bad origin"); }
    const allowed =
      u.hostname === "localhost"  ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1"       ||
      u.hostname === args.host   ||
      (args.allowOrigin !== null && origin === args.allowOrigin);
    cb(allowed, allowed ? 200 : 403, allowed ? "OK" : "Origin not permitted");
  },
});

// ── Per-connection bridge ─────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  const baseUrl  = `ws://localhost:${args.port}`;
  const reqUrl   = new URL(req.url ?? "/", baseUrl);
  const tcpHost  = reqUrl.searchParams.get("host") ?? "localhost";
  const tcpPort  = Number(reqUrl.searchParams.get("port") ?? 5900);

  if (!Number.isInteger(tcpPort) || tcpPort <= 0 || tcpPort > 65535) {
    ws.close(1008, "Invalid target port");
    return;
  }

  const clientAddr = req.socket.remoteAddress;
  console.log(`[proxy] ${clientAddr} -> tcp:${tcpHost}:${tcpPort}`);

  // Minimize keystroke/mouse latency over the browser <-> proxy leg.
  req.socket.setNoDelay(true);

  let tcpReady = false;
  const pending = [];

  const tcp = createConnection(tcpPort, tcpHost);
  tcp.setNoDelay(true);
  tcp.setKeepAlive(true, 30_000);

  tcp.on("connect", () => {
    console.log(`[proxy]   TCP connected to ${tcpHost}:${tcpPort}`);
    tcp.setNoDelay(true);
    tcpReady = true;
    for (const chunk of pending) tcp.write(chunk);
    pending.length = 0;
  });

  tcp.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk, { binary: true });
    }
  });

  tcp.on("end", () => {
    ws.close(1000, "Server closed connection");
  });

  tcp.on("error", (err) => {
    console.error(`[proxy]   TCP error: ${err.message}`);
    ws.close(1011, `TCP error: ${err.message}`);
  });

  tcp.on("close", () => {
    if (ws.readyState !== ws.CLOSED) ws.close(1001);
  });

  ws.on("message", (data, isBinary) => {
    const buf = Buffer.isBuffer(data)
      ? data
      : isBinary
        ? Buffer.from(data)
        : Buffer.from(data.toString());
    if (tcpReady) {
      tcp.write(buf);
    } else {
      pending.push(buf);
    }
  });

  ws.on("close", () => {
    tcp.destroy();
  });

  ws.on("error", (err) => {
    console.error(`[proxy]   WS error: ${err.message}`);
    tcp.destroy();
  });
});

// ── Start listening ───────────────────────────────────────────────────────

server.listen(args.port, args.host, () => {
  const displayHost = args.host === "127.0.0.1" ? "localhost" : args.host;
  console.log(`\nWeb VNC Proxy  ws://${displayHost}:${args.port}`);
  console.log(`Example:       ws://${displayHost}:${args.port}?host=my-server&port=5900`);
  if (args.host === "127.0.0.1") {
    console.log(`\nListening on loopback only. Use --host 0.0.0.0 to allow remote browsers.`);
  }
  console.log("Press Ctrl+C to stop.\n");
});
