const vscode = acquireVsCodeApi();

const hostEl = document.getElementById("host");
const portEl = document.getElementById("port");
const connectEl = document.getElementById("connect");
const disconnectEl = document.getElementById("disconnect");
const logEl = document.getElementById("log");

let currentSessionId = null;
let connectionState = "idle"; // idle | connecting | connected

function setButtons() {
  const canConnect = connectionState === "idle";
  const canDisconnect = connectionState === "connecting" || connectionState === "connected";
  if (connectEl) connectEl.disabled = !canConnect;
  if (disconnectEl) disconnectEl.disabled = !canDisconnect;
}

function log(line) {
  const now = new Date().toISOString().slice(11, 19);
  logEl.textContent += `[${now}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function connect() {
  if (connectionState !== "idle") {
    return;
  }

  const host = hostEl.value.trim();
  const port = Number(portEl.value.trim());
  if (!host || !Number.isInteger(port) || port <= 0) {
    log("Invalid host/port");
    return;
  }

  connectionState = "connecting";
  setButtons();

  vscode.postMessage({
    type: "connect",
    host,
    port,
  });

  log(`Connecting TCP to ${host}:${port}...`);
}

function disconnect() {
  if (connectionState === "idle") {
    return;
  }

  connectionState = "idle";
  setButtons();

  if (!currentSessionId) {
    log("Disconnect requested while connecting");
    return;
  }

  vscode.postMessage({
    type: "disconnect",
    sessionId: currentSessionId,
  });
  log(`Disconnect requested for ${currentSessionId}`);
}

connectEl?.addEventListener("click", connect);
disconnectEl?.addEventListener("click", disconnect);

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "tcp-event") {
    return;
  }

  const event = msg.event;
  switch (event.type) {
    case "connected":
      currentSessionId = event.sessionId;
      connectionState = "connected";
      setButtons();
      log(`Connected. Session=${event.sessionId}`);
      break;
    case "data":
      log(`RX ${Math.floor((event.payloadBase64.length * 3) / 4)} bytes`);
      break;
    case "closed":
      if (currentSessionId === event.sessionId) {
        currentSessionId = null;
        connectionState = "idle";
        setButtons();
      }
      log(`Closed ${event.sessionId} (${event.reason || "no reason"})`);
      break;
    case "error":
      if (currentSessionId === event.sessionId) {
        currentSessionId = null;
      }
      connectionState = "idle";
      setButtons();
      log(`Error ${event.sessionId}: ${event.message}`);
      break;
    default:
      break;
  }
});

log("Ready. This project uses direct TCP from extension host (no WebSocket).");
setButtons();
