/**
 * UI entry point.
 *
 * Handles:
 * - Connection form (URL + password)
 * - Canvas sizing and painting
 * - Keyboard and mouse input forwarding
 */
import { RfbClient } from "./rfb/client";

// ── X11 KeySym helpers ─────────────────────────────────────────────────────

const KEY_BACKSPACE  = 0xff08;
const KEY_TAB        = 0xff09;
const KEY_RETURN     = 0xff0d;
const KEY_ESCAPE     = 0xff1b;
const KEY_DELETE     = 0xffff;
const KEY_HOME       = 0xff50;
const KEY_LEFT       = 0xff51;
const KEY_UP         = 0xff52;
const KEY_RIGHT      = 0xff53;
const KEY_DOWN       = 0xff54;
const KEY_PAGE_UP    = 0xff55;
const KEY_PAGE_DOWN  = 0xff56;
const KEY_END        = 0xff57;
const KEY_INSERT     = 0xff63;
const KEY_F1         = 0xffbe;
const KEY_SHIFT_L    = 0xffe1;
const KEY_CONTROL_L  = 0xffe3;
const KEY_ALT_L      = 0xffe9;
const KEY_SUPER_L    = 0xffeb;

/** Map a browser KeyboardEvent.code to an X11 KeySym. */
function codeToKeysym(ev: KeyboardEvent): number {
  const map: Record<string, number> = {
    Backspace: KEY_BACKSPACE,
    Tab: KEY_TAB,
    Enter: KEY_RETURN,
    Escape: KEY_ESCAPE,
    Delete: KEY_DELETE,
    Home: KEY_HOME,
    ArrowLeft: KEY_LEFT,
    ArrowUp: KEY_UP,
    ArrowRight: KEY_RIGHT,
    ArrowDown: KEY_DOWN,
    PageUp: KEY_PAGE_UP,
    PageDown: KEY_PAGE_DOWN,
    End: KEY_END,
    Insert: KEY_INSERT,
    F1: KEY_F1, F2: KEY_F1 + 1, F3: KEY_F1 + 2, F4: KEY_F1 + 3,
    F5: KEY_F1 + 4, F6: KEY_F1 + 5, F7: KEY_F1 + 6, F8: KEY_F1 + 7,
    F9: KEY_F1 + 8, F10: KEY_F1 + 9, F11: KEY_F1 + 10, F12: KEY_F1 + 11,
    ShiftLeft: KEY_SHIFT_L,    ShiftRight: KEY_SHIFT_L + 1,
    ControlLeft: KEY_CONTROL_L,  ControlRight: KEY_CONTROL_L + 1,
    AltLeft: KEY_ALT_L,          AltRight: KEY_ALT_L + 1,
    MetaLeft: KEY_SUPER_L,       MetaRight: KEY_SUPER_L + 1,
  };
  if (map[ev.code] !== undefined) return map[ev.code]!;
  // Printable characters: use the Unicode code point
  if (ev.key.length === 1) return ev.key.charCodeAt(0);
  return 0;
}

// ── App state ──────────────────────────────────────────────────────────────

let client: RfbClient | null = null;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let connected = false;
let mode: "ws" | "tcp" = "ws";

// ── DOM helpers ───────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setStatus(msg: string): void {
  el("status").textContent = msg;
}

function setConnected(state: boolean): void {
  connected = state;
  el<HTMLButtonElement>("btn-connect").textContent = state ? "Disconnect" : "Connect";
  el<HTMLButtonElement>("btn-connect").classList.toggle("connected", state);
  // Disable all input fields while connected
  for (const id of ["input-url", "input-password", "input-vnc-host", "input-vnc-port", "input-proxy-port"]) {
    const inp = document.getElementById(id) as HTMLInputElement | null;
    if (inp) inp.disabled = state;
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".mode-btn")) {
    btn.disabled = state;
  }
  canvas.style.display = state ? "block" : "none";
  el("placeholder").style.display = state ? "none" : "flex";
}

// ── Canvas rendering ──────────────────────────────────────────────────────

function onFrame(imageData: ImageData): void {
  ctx.putImageData(imageData, 0, 0);
}

function onResize(w: number, h: number): void {
  canvas.width  = w;
  canvas.height = h;
}

// ── Input handling ────────────────────────────────────────────────────────

function onKeyDown(ev: KeyboardEvent): void {
  if (!client || !connected) return;
  ev.preventDefault();
  const sym = codeToKeysym(ev);
  if (sym) client.sendKeyEvent(sym, true);
}

function onKeyUp(ev: KeyboardEvent): void {
  if (!client || !connected) return;
  ev.preventDefault();
  const sym = codeToKeysym(ev);
  if (sym) client.sendKeyEvent(sym, false);
}

function onMouseMove(ev: MouseEvent): void {
  if (!client || !connected) return;
  const { x, y } = canvasPos(ev);
  const buttons = mouseButtons(ev.buttons);
  client.sendPointerEvent(x, y, buttons);
}

function onMouseDown(ev: MouseEvent): void {
  if (!client || !connected) return;
  ev.preventDefault();
  canvas.focus();
  const { x, y } = canvasPos(ev);
  client.sendPointerEvent(x, y, mouseButtons(ev.buttons));
}

function onMouseUp(ev: MouseEvent): void {
  if (!client || !connected) return;
  const { x, y } = canvasPos(ev);
  client.sendPointerEvent(x, y, mouseButtons(ev.buttons));
}

function onWheel(ev: WheelEvent): void {
  if (!client || !connected) return;
  ev.preventDefault();
  const { x, y } = canvasPos(ev);
  const base = mouseButtons(ev.buttons);
  // Button 4 = scroll up, button 5 = scroll down
  const scrollBtn = ev.deltaY < 0 ? 0x08 : 0x10;
  client.sendPointerEvent(x, y, base | scrollBtn);
  client.sendPointerEvent(x, y, base); // release scroll button
}

function canvasPos(ev: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.round((ev.clientX - rect.left) * scaleX),
    y: Math.round((ev.clientY - rect.top)  * scaleY),
  };
}

/** Map browser button bitmask to RFB button mask. */
function mouseButtons(b: number): number {
  let mask = 0;
  if (b & 1) mask |= 0x01; // left
  if (b & 4) mask |= 0x02; // middle
  if (b & 2) mask |= 0x04; // right
  return mask;
}

// ── Connect / disconnect ──────────────────────────────────────────────────

function buildUrl(): string | null {
  if (mode === "ws") {
    const url = el<HTMLInputElement>("input-url").value.trim();
    if (!url) { setStatus("Enter a WebSocket URL"); return null; }
    return url;
  }
  // TCP mode: construct WebSocket URL pointing to the local proxy
  const host      = el<HTMLInputElement>("input-vnc-host").value.trim();
  const vncPort   = Number(el<HTMLInputElement>("input-vnc-port").value);
  const proxyPort = Number(el<HTMLInputElement>("input-proxy-port").value);
  if (!host) { setStatus("Enter a VNC hostname"); return null; }
  if (!Number.isInteger(vncPort) || vncPort <= 0) { setStatus("Invalid VNC port"); return null; }
  if (!Number.isInteger(proxyPort) || proxyPort <= 0) { setStatus("Invalid proxy port"); return null; }
  const encodedHost = encodeURIComponent(host);
  return `ws://localhost:${proxyPort}?host=${encodedHost}&port=${vncPort}`;
}

function doConnect(): void {
  const url      = buildUrl();
  const password = el<HTMLInputElement>("input-password").value;

  if (url === null) return;

  client = new RfbClient({
    url,
    password: password || undefined,
    onFrame,
    onResize,
    onStatus: setStatus,
    onDisconnect(reason) {
      setStatus(`Disconnected: ${reason}`);
      setConnected(false);
      client = null;
    },
  });

  setConnected(true);
  client.connect();
}

function doDisconnect(): void {
  client?.disconnect();
  client = null;
  setConnected(false);
  setStatus("Disconnected");
}

// ── Startup ───────────────────────────────────────────────────────────────

function init(): void {
  canvas = el<HTMLCanvasElement>("vnc-canvas");
  ctx = canvas.getContext("2d")!;

  // Attach input listeners to the canvas
  canvas.setAttribute("tabindex", "0");
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  el("btn-connect").addEventListener("click", () => {
    if (connected) doDisconnect();
    else doConnect();
  });

  // Allow pressing Enter in the URL field to connect
  el("input-url").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && !connected) doConnect();
  });
  el("input-vnc-host").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && !connected) doConnect();
  });

  // Mode toggle
  document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (connected) return;
      const newMode = btn.dataset["mode"] as "ws" | "tcp";
      if (newMode === mode) return;
      mode = newMode;
      document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset["mode"] === mode);
      });
      const wsFields  = document.querySelector<HTMLElement>(".mode-ws")!;
      const tcpFields = document.querySelector<HTMLElement>(".mode-tcp")!;
      wsFields.style.display  = mode === "ws"  ? "flex" : "none";
      tcpFields.style.display = mode === "tcp" ? "flex" : "none";
    });
  });

  // Monitor viewport changes and request remote resize
  const main = document.getElementById("main")!;
  let resizeTimeout: number | null = null;
  
  const handleViewportResize = () => {
    if (!client || !connected) return;
    // Debounce resize to avoid spamming updates
    if (resizeTimeout !== null) clearTimeout(resizeTimeout);
    resizeTimeout = window.setTimeout(() => {
      const viewportWidth = main.clientWidth;
      const viewportHeight = main.clientHeight;
      if (viewportWidth > 0 && viewportHeight > 0) {
        // Request remote to resize - this handles support detection and rate limiting
        client.requestRemoteResize(viewportWidth, viewportHeight);
      }
      resizeTimeout = null;
    }, 300); // Wait 300ms after resize stops before requesting update
  };

  const resizeObserver = new ResizeObserver(handleViewportResize);
  resizeObserver.observe(main);
  
  // Also listen to window resize events
  window.addEventListener("resize", handleViewportResize);
}

document.addEventListener("DOMContentLoaded", init);
