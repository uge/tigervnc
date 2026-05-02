/**
 * UI entry point.
 *
 * Handles:
 * - Connection form (URL + password)
 * - Canvas sizing and painting
 * - Keyboard and mouse input forwarding
 */
import { RfbClient, type RfbClientStats, type RfbEncodingMode, type DirtyRect } from "./rfb/client";
import { getInflateBackendStatus } from "./codecs/tightInflateBackend";

type SessionColorDepth = "8-bit" | "16-bit" | "24-bit";

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
const KEY_SHIFT_R    = 0xffe2;
const KEY_CONTROL_L  = 0xffe3;
const KEY_CONTROL_R  = 0xffe4;
const KEY_ALT_L      = 0xffe9;
const KEY_ALT_R      = 0xffea;
const KEY_SUPER_L    = 0xffeb;
const KEY_SUPER_R    = 0xffec;

/** All modifier keysyms to release on session connect. */
const MODIFIER_KEYSYMS = [
  KEY_SHIFT_L, KEY_SHIFT_R,
  KEY_CONTROL_L, KEY_CONTROL_R,
  KEY_ALT_L, KEY_ALT_R,
  KEY_SUPER_L, KEY_SUPER_R,
];

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
let selectedEncodingMode: RfbEncodingMode = "auto";
let adaptiveProtocolDepthEnabled = true;
let adaptiveMinSwitchIntervalMs = 4000;
let lastAdaptiveSwitchTs = 0;
let adaptiveColorDepth = "24-bit";
let adaptiveConnectionStartTs = 0;
let adaptiveProtocolLocked = false;
let adaptiveProtocolEligible = true;
let sessionColorDepthOverride: SessionColorDepth | null = null;
let clipboardEnabled = false;
let lastClipboardText = "";
let initialResizeRetryTimer: number | null = null;
let initialResizeAttempts = 0;
let pendingFrame: ImageData | null = null;
let pendingDirtyRects: DirtyRect[] = [];
let frameFlushScheduled = false;
let hasRenderedFirstFrame = false;
let isConnecting = false;
let useDirtyRects = true; // High-performance dirty rectangle mode
let frameCallbackCount = 0;
let frameFlushCount = 0;
let zeroRectFrameCount = 0;
let syncFirstFrameCount = 0;
let lastSurfaceSignature = "";
let fpsWindowStart = 0;
let fpsWindowFrames = 0;
let currentFps = 0;
let thumbnailCanvas: HTMLCanvasElement | null = null;
let thumbnailCtx: CanvasRenderingContext2D | null = null;
let lastThumbnailSentAt = 0;
let thumbnailTimer: number | null = null;

const INITIAL_RESIZE_MAX_ATTEMPTS = 12;
const INITIAL_RESIZE_RETRY_MS = 400;
const BACKGROUND_REFRESH_FPS = 0; // Completely pause frame requests when tab is hidden
const FOREGROUND_REFRESH_FPS = 60;
const TAB_THUMBNAIL_INTERVAL_MS = 1500;
const TAB_THUMBNAIL_SIZE = 32;
const ENABLE_REMOTE_RESIZE = true;
const MOUSE_MOVE_DELAY = 17; // Minimum ms between mouse move events (~60fps)

// Debug output control
let debugEnabled = false;

// ── Keyboard state tracking ───────────────────────────────────────────────
// Track pressed keys: code -> keysym. Ensures we use the same keysym on
// release as on press, and prevents duplicate down events.
const keyDownList = new Map<string, number>();

// ── Mouse throttling state ────────────────────────────────────────────────
let lastMouseMoveTime = 0;
let mouseMoveTimer: number | null = null;
let pendingMousePos: { x: number; y: number } | null = null;
let pendingMouseButtons = 0;

const DEFAULT_STATS: RfbClientStats = {
  encoding: "None",
  colorDepth: "24-bit RGBX",
  receivedRate: 0,
  updatesPerSecond: 0,
  latencyMs: 0,
  avgFrameMs: 0,
  avgWorkerDecodeMs: 0,
  avgBlitMs: 0,
  tightWorkerBreakdown: "-",
  workerQueueDepth: 0,
  bottleneckHint: "balanced",
};

function updateVisibilityRefreshPolicy(): void {
  if (!client) return;
  const isVisible = document.visibilityState === "visible";
  client.setTargetFrameRate(isVisible ? FOREGROUND_REFRESH_FPS : BACKGROUND_REFRESH_FPS);
  if (isVisible && connected) {
    forceRedraw();
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setStatus(msg: string): void {
  el("status").textContent = msg;
  getVsCodeApi()?.postMessage({ type: "vnc:status", message: msg });

  // Reset modifier keys when connection is established to clear any stuck state.
  if (msg === "Connected") {
    resetModifierKeys();
  }
}

/**
 * Send key-up events for all modifier keys to reset keyboard state.
 * Called on session connect to ensure modifiers are not stuck from previous sessions.
 */
function resetModifierKeys(): void {
  if (!client || !connected) return;
  for (const keysym of MODIFIER_KEYSYMS) {
    client.sendKeyEvent(keysym, false);
  }
  // Also clear our local tracking state
  keyDownList.clear();
}

/**
 * Release all currently pressed keys. Called on window blur to prevent
 * stuck keys when focus is lost.
 */
function releaseAllKeys(): void {
  if (!client || !connected) return;
  for (const [code, keysym] of keyDownList) {
    client.sendKeyEvent(keysym, false);
  }
  keyDownList.clear();
}

function formatDataRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MiB/s`;
}

function setStats(stats: RfbClientStats): void {
  el("stat-current-encoding").textContent = stats.encoding;
  el("stat-depth").textContent = stats.colorDepth;
  el("stat-rate").textContent = formatDataRate(stats.receivedRate);
  el("stat-ups").textContent = stats.updatesPerSecond.toFixed(1);
  el("stat-frame").textContent = `${stats.avgFrameMs.toFixed(1)} ms`;
  el("stat-worker").textContent = `${stats.avgWorkerDecodeMs.toFixed(1)} ms`;
  el("stat-blit").textContent = `${stats.avgBlitMs.toFixed(1)} ms`;
  el("stat-tight").textContent = stats.tightWorkerBreakdown;
  el("stat-queue").textContent = String(stats.workerQueueDepth);
  el("stat-limit").textContent = stats.bottleneckHint;

  maybeAdaptProtocolAndDepth(stats);

  const inflateBackend = getInflateBackendStatus();
  const workerFallbackActive = client ? client.isWorkerFallbackActive() : false;

  getVsCodeApi()?.postMessage({
    type: "vnc:stats",
    stats: {
      ...stats,
      fps: currentFps,
      autoProtocol: selectedEncodingMode,
      autoColorDepth: adaptiveColorDepth,
      inflateBackend: inflateBackend ?? undefined,
      workerFallbackActive,
    },
  });
}

function setFps(fps: number): void {
  currentFps = fps;
  el("stat-fps").textContent = fps.toFixed(1);
}

function maybeAdaptProtocolAndDepth(stats: RfbClientStats): void {
  if (!adaptiveProtocolDepthEnabled || !client || !connected) return;
  if (selectedEncodingMode !== "auto") return;

  const now = Date.now();

  let targetProtocol: RfbEncodingMode;
  let targetColorDepth: string;

  if (stats.latencyMs > 180 || stats.receivedRate < 320 * 1024) {
    targetProtocol = "zrle";
    targetColorDepth = "8-bit";
  } else if (stats.latencyMs > 90 || stats.receivedRate < 1200 * 1024) {
    targetProtocol = "tight";
    targetColorDepth = "16-bit";
  } else {
    targetProtocol = "h264";
    targetColorDepth = "24-bit";
  }

  const protocolChanged = targetProtocol !== selectedEncodingMode;
  const nextColorDepth = sessionColorDepthOverride ?? targetColorDepth;
  const depthChanged = nextColorDepth !== adaptiveColorDepth;
  if (!protocolChanged && !depthChanged) return;

  adaptiveColorDepth = nextColorDepth;

  // The current decoder/pixel pipeline is fixed RGBX, so color depth is still
  // a policy/reporting signal rather than a live wire-format switch.
  if (!adaptiveProtocolEligible || adaptiveProtocolLocked) {
    return;
  }

  // Observe the connection briefly before making a single stable auto choice.
  if (now - adaptiveConnectionStartTs < 2000) return;
  if (stats.updatesPerSecond < 2) return;
  if (now - lastAdaptiveSwitchTs < adaptiveMinSwitchIntervalMs) return;

  if (protocolChanged) {
    selectedEncodingMode = targetProtocol;
    const encodingSelect = document.getElementById("encoding-mode") as HTMLSelectElement | null;
    if (encodingSelect) {
      encodingSelect.value = targetProtocol;
    }
    client.setEncodingMode(targetProtocol);
  }

  // Decoder currently runs in a fixed RGBX pipeline; depth changes are policy metadata
  // for adaptation visibility. Force a full update after policy changes.
  client.requestFramebufferUpdate(0, 0, undefined, undefined, false);
  setStatus(`Auto: ${targetProtocol.toUpperCase()} / ${adaptiveColorDepth}`);
  lastAdaptiveSwitchTs = now;
  adaptiveProtocolLocked = true;
}

function trackRenderedFrame(now: number): void {
  if (fpsWindowStart === 0) {
    fpsWindowStart = now;
    fpsWindowFrames = 0;
  }

  fpsWindowFrames += 1;
  const elapsedMs = now - fpsWindowStart;
  if (elapsedMs >= 500) {
    const fps = (fpsWindowFrames * 1000) / elapsedMs;
    setFps(fps);
    fpsWindowStart = now;
    fpsWindowFrames = 0;
  }
}

function setConnected(state: boolean): void {
  connected = state;
  if (!state) {
    isConnecting = false;
  }
  getVsCodeApi()?.postMessage({ type: "vnc:connectedState", connected: state });
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
  // Enable/disable clipboard toggle based on connection state
  const clipboardToggle = el<HTMLInputElement>("clipboard-toggle");
  clipboardToggle.checked = clipboardEnabled;
  clipboardToggle.disabled = !state;
  if (!state) {
    hasRenderedFirstFrame = false;
    frameCallbackCount = 0;
    frameFlushCount = 0;
    zeroRectFrameCount = 0;
    syncFirstFrameCount = 0;
    lastSurfaceSignature = "";
  }
  updateConnectionSurface();
  if (!state) {
    setStats(DEFAULT_STATS);
    setFps(0);
    fpsWindowStart = 0;
    fpsWindowFrames = 0;
    lastThumbnailSentAt = 0;
    if (thumbnailTimer !== null) {
      window.clearTimeout(thumbnailTimer);
      thumbnailTimer = null;
    }
  }
}

function updateConnectionSurface(): void {
  const showCanvas = connected && hasRenderedFirstFrame;
  const showPlaceholder = !connected && !isConnecting;
  canvas.style.display = showCanvas ? "block" : "none";
  el("placeholder").style.display = showPlaceholder ? "flex" : "none";

  const signature = `connected=${connected} connecting=${isConnecting} firstFrame=${hasRenderedFirstFrame} canvas=${canvas.style.display} placeholder=${el("placeholder").style.display}`;
  if (signature !== lastSurfaceSignature) {
    lastSurfaceSignature = signature;
    postDebug(`[Render] Surface: ${signature}`);
  }
}

function markFirstFrameRendered(): void {
  if (hasRenderedFirstFrame) return;
  isConnecting = false;
  hasRenderedFirstFrame = true;
  postDebug(`[Render] First frame marked rendered. canvas=${canvas.width}x${canvas.height} callbacks=${frameCallbackCount} flushes=${frameFlushCount}`);
  updateConnectionSurface();
}

// ── Canvas rendering ──────────────────────────────────────────────────────

function onFrame(imageData: ImageData): void {
  frameCallbackCount += 1;

  // Guarantee visibility by drawing first frame synchronously.
  if (!hasRenderedFirstFrame) {
    syncFirstFrameCount += 1;
    trackRenderedFrame(performance.now());
    markFirstFrameRendered();
    ctx.putImageData(imageData, 0, 0);
    postDebug(`[Render] onFrame synchronous first draw #${syncFirstFrameCount}`);
    scheduleTabThumbnailUpdate();
    return;
  }

  // Keep only the newest frame to avoid render queue buildup under load.
  pendingFrame = imageData;
  pendingDirtyRects = [];
  if (frameFlushScheduled) return;

  frameFlushScheduled = true;
  requestAnimationFrame(() => {
    frameFlushCount += 1;
    const frame = pendingFrame;
    pendingFrame = null;
    pendingDirtyRects = [];
    frameFlushScheduled = false;
    if (!frame) return;

    trackRenderedFrame(performance.now());
    markFirstFrameRendered();
    ctx.putImageData(frame, 0, 0);
    scheduleTabThumbnailUpdate();
  });
}

function onFrameWithDirtyRects(imageData: ImageData, dirtyRects: DirtyRect[]): void {
  frameCallbackCount += 1;

  // Guarantee visibility by drawing first frame synchronously.
  if (!hasRenderedFirstFrame) {
    syncFirstFrameCount += 1;
    trackRenderedFrame(performance.now());
    markFirstFrameRendered();
    ctx.putImageData(imageData, 0, 0);
    postDebug(`[Render] onFrameWithDirtyRects synchronous first draw #${syncFirstFrameCount} rects=${dirtyRects.length}`);
    scheduleTabThumbnailUpdate();
    return;
  }

  // High-performance path: only update dirty rectangles
  pendingFrame = imageData;
  pendingDirtyRects = dirtyRects;
  if (frameFlushScheduled) return;

  frameFlushScheduled = true;
  requestAnimationFrame(() => {
    frameFlushCount += 1;
    const frame = pendingFrame;
    const rects = pendingDirtyRects;
    pendingFrame = null;
    pendingDirtyRects = [];
    frameFlushScheduled = false;
    if (!frame) return;

    trackRenderedFrame(performance.now());
    markFirstFrameRendered();

    if (rects.length === 0) {
      zeroRectFrameCount += 1;
      if (zeroRectFrameCount <= 5 || zeroRectFrameCount % 60 === 0) {
        postDebug(`[Render] zero-dirty-rect frame #${zeroRectFrameCount}; full blit`);
      }
      // No dirty rects (e.g. frame contained only pseudo-encoding updates).
      // Still commit a full blit so the canvas becomes visible on first frame.
      ctx.putImageData(frame, 0, 0);
      scheduleTabThumbnailUpdate();
      return;
    }

    // Render only dirty rectangles when coverage is small enough.
    let dirtyPixels = 0;
    for (const rect of rects) {
      dirtyPixels += rect.width * rect.height;
    }
    const framePixels = frame.width * frame.height;
    const dirtyCoverage = framePixels > 0 ? dirtyPixels / framePixels : 1;

    if (useDirtyRects && rects.length <= 128 && dirtyCoverage <= 0.35) {
      for (const rect of rects) {
        // Draw only the dirty source region from the full framebuffer image data.
        ctx.putImageData(frame, 0, 0, rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      // Fall back to full-frame update if too many rects
      ctx.putImageData(frame, 0, 0);
    }
    scheduleTabThumbnailUpdate();
  });
}

function scheduleTabThumbnailUpdate(): void {
  // Disabled: using static TigerVNC icon instead of dynamic thumbnails
  return;
}

function pushTabThumbnail(): void {
  if (!connected || canvas.width === 0 || canvas.height === 0) return;

  if (!thumbnailCanvas) {
    thumbnailCanvas = document.createElement("canvas");
    thumbnailCanvas.width = TAB_THUMBNAIL_SIZE;
    thumbnailCanvas.height = TAB_THUMBNAIL_SIZE;
    thumbnailCtx = thumbnailCanvas.getContext("2d", { alpha: false });
  }
  if (!thumbnailCanvas || !thumbnailCtx) return;

  const thumb = thumbnailCtx;
  const scale = Math.min(TAB_THUMBNAIL_SIZE / canvas.width, TAB_THUMBNAIL_SIZE / canvas.height);
  const drawWidth = Math.max(1, Math.round(canvas.width * scale));
  const drawHeight = Math.max(1, Math.round(canvas.height * scale));
  const dx = Math.floor((TAB_THUMBNAIL_SIZE - drawWidth) / 2);
  const dy = Math.floor((TAB_THUMBNAIL_SIZE - drawHeight) / 2);

  thumb.fillStyle = "#111";
  thumb.fillRect(0, 0, TAB_THUMBNAIL_SIZE, TAB_THUMBNAIL_SIZE);
  thumb.imageSmoothingEnabled = true;
  thumb.drawImage(canvas, dx, dy, drawWidth, drawHeight);

  lastThumbnailSentAt = Date.now();
  getVsCodeApi()?.postMessage({
    type: "vnc:thumbnail",
    dataUrl: thumbnailCanvas.toDataURL("image/png"),
  });
}

function onResize(w: number, h: number): void {
  canvas.width  = w;
  canvas.height = h;
  postDebug(`[Render] onResize remote=${w}x${h}`);

  // Stop connect-time retries once the first remote resize has arrived.
  stopInitialResizeRetry();
}

function stopInitialResizeRetry(): void {
  if (initialResizeRetryTimer !== null) {
    window.clearTimeout(initialResizeRetryTimer);
    initialResizeRetryTimer = null;
  }
  initialResizeAttempts = 0;
}

function startInitialResizeRetry(): void {
  stopInitialResizeRetry();

  const attemptResize = () => {
    if (!client || !connected) {
      stopInitialResizeRetry();
      return;
    }

    requestResizeToViewport();
    initialResizeAttempts += 1;

    if (initialResizeAttempts < INITIAL_RESIZE_MAX_ATTEMPTS) {
      initialResizeRetryTimer = window.setTimeout(attemptResize, INITIAL_RESIZE_RETRY_MS);
    } else {
      initialResizeRetryTimer = null;
    }
  };

  // First retry shortly after connection/lifecycle settles.
  initialResizeRetryTimer = window.setTimeout(attemptResize, 150);
}

function requestResizeToViewport(): void {
  if (!client || !connected) return;
  if (!ENABLE_REMOTE_RESIZE) return;
  const main = document.getElementById("main") as HTMLElement | null;
  if (!main) return;
  const { width: viewportWidth, height: viewportHeight } = getPaintableViewportSize(main, canvas);
  if (viewportWidth > 0 && viewportHeight > 0) {
    client.requestRemoteResize(viewportWidth, viewportHeight);
  }
}

// ── Input handling ────────────────────────────────────────────────────────

function onKeyDown(ev: KeyboardEvent): void {
  if (!client || !connected) return;
  ev.preventDefault();
  
  const code = ev.code;
  
  // If this key is already pressed, use the same keysym for the repeat
  const existingSym = keyDownList.get(code);
  if (existingSym !== undefined) {
    // Send repeat (key already down, send same keysym again)
    client.sendKeyEvent(existingSym, true);
    return;
  }
  
  const sym = codeToKeysym(ev);
  if (sym) {
    keyDownList.set(code, sym);
    client.sendKeyEvent(sym, true);
  }
}

function onKeyUp(ev: KeyboardEvent): void {
  if (!client || !connected) return;
  ev.preventDefault();
  
  const code = ev.code;
  
  // Use the same keysym we sent on keydown
  const sym = keyDownList.get(code);
  if (sym !== undefined) {
    keyDownList.delete(code);
    client.sendKeyEvent(sym, false);
  }
}

function onWindowBlur(): void {
  releaseAllKeys();
  // Also cancel any pending mouse move
  if (mouseMoveTimer !== null) {
    window.clearTimeout(mouseMoveTimer);
    mouseMoveTimer = null;
  }
  pendingMousePos = null;
}

function flushPendingMouseMove(): void {
  mouseMoveTimer = null;
  if (!client || !connected || !pendingMousePos) return;
  client.sendPointerEvent(pendingMousePos.x, pendingMousePos.y, pendingMouseButtons);
  lastMouseMoveTime = Date.now();
  pendingMousePos = null;
}

function onMouseMove(ev: MouseEvent): void {
  if (!client || !connected) return;
  const { x, y } = canvasPos(ev);
  const buttons = mouseButtons(ev.buttons);
  
  // Throttle mouse moves to ~60fps to avoid flooding the server
  const now = Date.now();
  const timeSinceLastMove = now - lastMouseMoveTime;
  
  if (timeSinceLastMove >= MOUSE_MOVE_DELAY) {
    // Enough time has passed, send immediately
    client.sendPointerEvent(x, y, buttons);
    lastMouseMoveTime = now;
    // Clear any pending move
    if (mouseMoveTimer !== null) {
      window.clearTimeout(mouseMoveTimer);
      mouseMoveTimer = null;
    }
    pendingMousePos = null;
  } else {
    // Too soon, queue the move
    pendingMousePos = { x, y };
    pendingMouseButtons = buttons;
    if (mouseMoveTimer === null) {
      mouseMoveTimer = window.setTimeout(flushPendingMouseMove, MOUSE_MOVE_DELAY - timeSinceLastMove);
    }
  }
}

function onMouseDown(ev: MouseEvent): void {
  if (!client || !connected) return;
  ev.preventDefault();
  canvas.focus();
  // Flush any pending mouse move before button press
  if (pendingMousePos) {
    if (mouseMoveTimer !== null) {
      window.clearTimeout(mouseMoveTimer);
      mouseMoveTimer = null;
    }
    client.sendPointerEvent(pendingMousePos.x, pendingMousePos.y, pendingMouseButtons);
    pendingMousePos = null;
  }
  const { x, y } = canvasPos(ev);
  client.sendPointerEvent(x, y, mouseButtons(ev.buttons));
  lastMouseMoveTime = Date.now();
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

function onRemoteClipboard(text: string): void {
  if (!clipboardEnabled || !connected) return;
  if (!navigator.clipboard?.writeText) return;
  // Update local snapshot first so poll loop does not echo remote text back.
  lastClipboardText = text;
  navigator.clipboard.writeText(text).catch((err) => {
    console.warn("Failed to write clipboard:", err);
  });
}

function syncLocalClipboardToServerIfEnabled(): void {
  if (!clipboardEnabled || !connected || !client) return;
  if (!navigator.clipboard?.readText) return;
  navigator.clipboard.readText()
    .then((text) => {
      if (!client || !clipboardEnabled) return;
      lastClipboardText = text;
      client.sendClipboardText(text);
    })
    .catch((err) => {
      console.warn("Failed to read clipboard:", err);
    });
}

function onRemoteCursor(cursorCss: string): void {
  canvas.style.cursor = cursorCss;
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

function getPaintableViewportSize(container: HTMLElement, target: HTMLElement): { width: number; height: number } {
  const containerStyle = window.getComputedStyle(container);
  const targetStyle = window.getComputedStyle(target);

  const paddingX = parseFloat(containerStyle.paddingLeft) + parseFloat(containerStyle.paddingRight);
  const paddingY = parseFloat(containerStyle.paddingTop) + parseFloat(containerStyle.paddingBottom);
  const marginX = parseFloat(targetStyle.marginLeft) + parseFloat(targetStyle.marginRight);
  const marginY = parseFloat(targetStyle.marginTop) + parseFloat(targetStyle.marginBottom);

  return {
    width: Math.max(0, Math.floor(container.clientWidth - paddingX - marginX)),
    height: Math.max(0, Math.floor(container.clientHeight - paddingY - marginY)),
  };
}

// ── VS Code postMessage transport ─────────────────────────────────────────

/**
 * Acquire the VS Code webview API once and cache it. Returns undefined when
 * running outside a VS Code webview.
 */
let _vscodeApi: { postMessage(msg: unknown): void } | undefined;
function getVsCodeApi(): { postMessage(msg: unknown): void } | undefined {
  if (_vscodeApi !== undefined) return _vscodeApi;
  if (typeof (window as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === "function") {
    _vscodeApi = (window as unknown as { acquireVsCodeApi(): { postMessage(msg: unknown): void } }).acquireVsCodeApi();
  }
  return _vscodeApi;
}

/**
 * Fake WebSocket-compatible transport that tunnels RFB data through
 * VS Code's extension-host postMessage channel instead of a WebSocket.
 * The extension host owns the real TCP socket to the VNC server.
 */
class VsCodeTransport {
  readyState = 0; // CONNECTING
  binaryType = "arraybuffer";

  private _onopen: ((ev: Event) => void) | null = null;
  private _onmessage: ((ev: MessageEvent<ArrayBuffer>) => void) | null = null;
  private _onclose: ((ev: CloseEvent) => void) | null = null;
  private _onerror: ((ev: Event) => void) | null = null;

  set onopen(handler: ((ev: Event) => void) | null) {
    this._onopen = handler;
    this.flushPendingEvents();
  }

  get onopen(): ((ev: Event) => void) | null {
    return this._onopen;
  }

  set onmessage(handler: ((ev: MessageEvent<ArrayBuffer>) => void) | null) {
    this._onmessage = handler;
    this.flushPendingEvents();
  }

  get onmessage(): ((ev: MessageEvent<ArrayBuffer>) => void) | null {
    return this._onmessage;
  }

  set onclose(handler: ((ev: CloseEvent) => void) | null) {
    this._onclose = handler;
    this.flushPendingEvents();
  }

  get onclose(): ((ev: CloseEvent) => void) | null {
    return this._onclose;
  }

  set onerror(handler: ((ev: Event) => void) | null) {
    this._onerror = handler;
    this.flushPendingEvents();
  }

  get onerror(): ((ev: Event) => void) | null {
    return this._onerror;
  }

  private sessionId: string | null = null;
  private readonly api: { postMessage(msg: unknown): void };
  private readonly msgHandler: (ev: MessageEvent) => void;
  private pendingOpen = false;
  private pendingMessages: ArrayBuffer[] = [];
  private pendingCloseReason: string | null = null;

  constructor(host: string, port: number) {
    this.api = getVsCodeApi()!;
    this.msgHandler = (ev: MessageEvent) => {
      const msg = ev.data as Record<string, unknown>;
      if (!msg || typeof msg !== "object") return;

      if (msg["type"] === "tcp:connected" && this.sessionId === null) {
        this.sessionId = msg["sessionId"] as string;
        this.readyState = 1; // OPEN
        this.pendingOpen = true;
        this.flushPendingEvents();
      } else if (msg["type"] === "tcp:data" && msg["sessionId"] === this.sessionId) {
        // Decode base64 payload to ArrayBuffer
        const b64 = msg["payloadBase64"] as string;
        const binary = atob(b64);
        const buf = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
        this.pendingMessages.push(buf.buffer);
        this.flushPendingEvents();
      } else if (
        (msg["type"] === "tcp:closed" || msg["type"] === "tcp:error") &&
        msg["sessionId"] === this.sessionId
      ) {
        this.pendingCloseReason = msg["type"] === "tcp:error" ? "TCP error" : String(msg["reason"] ?? "");
        this.flushPendingEvents();
      }
    };
    window.addEventListener("message", this.msgHandler);
    this.api.postMessage({ type: "connect", host, port });
  }

  private flushPendingEvents(): void {
    if (this.pendingOpen && this._onopen) {
      this.pendingOpen = false;
      this._onopen(new Event("open"));
    }

    if (this._onmessage && this.pendingMessages.length > 0) {
      const queued = this.pendingMessages;
      this.pendingMessages = [];
      for (const data of queued) {
        this._onmessage(new MessageEvent("message", { data }));
      }
    }

    if (this.pendingCloseReason !== null && this._onclose) {
      const reason = this.pendingCloseReason;
      this.pendingCloseReason = null;
      this._close(reason);
    }
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1 || this.sessionId === null) return;
    let bytes: Uint8Array;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      bytes = new TextEncoder().encode(String(data));
    }
    // Encode to base64 in chunks to avoid call-stack overflows on large buffers
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    this.api.postMessage({ type: "write", sessionId: this.sessionId, payloadBase64: btoa(binary) });
  }

  close(_code?: number, _reason?: string): void {
    if (this.sessionId !== null) {
      this.api.postMessage({ type: "disconnect", sessionId: this.sessionId });
    }
    this._close("User disconnect");
  }

  private _close(reason: string): void {
    this.readyState = 3; // CLOSED
    window.removeEventListener("message", this.msgHandler);
    this._onclose?.(new CloseEvent("close", { code: 1000, reason, wasClean: true }));
  }
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

function postDebug(msg: string): void {
  if (!debugEnabled) return;
  getVsCodeApi()?.postMessage({ type: "vnc:debug", message: msg });
}

function doConnect(): void {
  const password = el<HTMLInputElement>("input-password").value;
  adaptiveColorDepth = sessionColorDepthOverride ?? "24-bit";
  lastAdaptiveSwitchTs = 0;
  adaptiveConnectionStartTs = Date.now();
  adaptiveProtocolLocked = false;
  adaptiveProtocolEligible = adaptiveProtocolDepthEnabled && selectedEncodingMode === "auto";

  // When running inside a VS Code webview, use the direct TCP transport
  // (extension host owns the real socket). No WebSocket proxy needed.
  let transport: VsCodeTransport | undefined;
  let url: string | null = null;

  if (mode === "tcp" && getVsCodeApi() !== undefined) {
    const host    = el<HTMLInputElement>("input-vnc-host").value.trim();
    const vncPort = Number(el<HTMLInputElement>("input-vnc-port").value);
    if (!host) { setStatus("Enter a VNC hostname"); return; }
    if (!Number.isInteger(vncPort) || vncPort <= 0) { setStatus("Invalid VNC port"); return; }
    transport = new VsCodeTransport(host, vncPort);
  } else {
    url = buildUrl();
    if (url === null) return;
  }

  isConnecting = true;
  hasRenderedFirstFrame = false;
  updateConnectionSurface();

  client = new RfbClient({
    url: url ?? undefined,
    transport,
    password: password || undefined,
    encodingMode: selectedEncodingMode,
    onFrameWithDirtyRects,
    onResize,
    onStats: setStats,
    onClipboard: onRemoteClipboard,
    onCursor: onRemoteCursor,
    onStatus: setStatus,
    onLog: postDebug,
    onDisconnect(reason) {
      setStatus(`Disconnected: ${reason}`);
      setConnected(false);
      canvas.style.cursor = "default";
      stopInitialResizeRetry();
      client = null;
    },
  });

  setConnected(true);
  client.connect();
  updateVisibilityRefreshPolicy();
  if (ENABLE_REMOTE_RESIZE) {
    // Request an initial remote resize and retry briefly while capability/state settles.
    window.setTimeout(requestResizeToViewport, 0);
    startInitialResizeRetry();
  }
}

function doDisconnect(): void {
  isConnecting = false;
  client?.disconnect();
  client = null;
  adaptiveProtocolLocked = false;
  setConnected(false);
  canvas.style.cursor = "default";
  pendingFrame = null;
  frameFlushScheduled = false;
  stopInitialResizeRetry();
  // Clear keyboard and mouse state
  keyDownList.clear();
  if (mouseMoveTimer !== null) {
    window.clearTimeout(mouseMoveTimer);
    mouseMoveTimer = null;
  }
  pendingMousePos = null;
  setStatus("Disconnected");
}

function forceRedraw(): void {
  if (!client || !connected) return;
  client.requestFramebufferUpdate(0, 0, undefined, undefined, hasRenderedFirstFrame);
}

// ── Startup ───────────────────────────────────────────────────────────────

function init(): void {
  const preset = (
    window as unknown as {
      __VNC_TCP_PRESET__?: {
        autoSelectProtocolDepth?: boolean;
        autoSelectMinSwitchIntervalMs?: number;
        protocolOverride?: RfbEncodingMode;
        colorDepthOverride?: SessionColorDepth;
        clipboardEnabled?: boolean;
        debugEnabled?: boolean;
      };
    }
  ).__VNC_TCP_PRESET__;
  if (preset) {
    debugEnabled = preset.debugEnabled ?? false;
    adaptiveProtocolDepthEnabled = preset.autoSelectProtocolDepth ?? adaptiveProtocolDepthEnabled;
    adaptiveMinSwitchIntervalMs = preset.autoSelectMinSwitchIntervalMs ?? adaptiveMinSwitchIntervalMs;
    selectedEncodingMode = preset.protocolOverride ?? selectedEncodingMode;
    sessionColorDepthOverride = preset.colorDepthOverride ?? null;
    adaptiveColorDepth = sessionColorDepthOverride ?? adaptiveColorDepth;
    clipboardEnabled = preset.clipboardEnabled ?? clipboardEnabled;
  }

  canvas = el<HTMLCanvasElement>("vnc-canvas");
  const context =
    canvas.getContext("2d", { alpha: false, desynchronized: true } as CanvasRenderingContext2DSettings)
    ?? canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to initialize 2D canvas context");
  }
  ctx = context;
  ctx.imageSmoothingEnabled = false;
  setStats(DEFAULT_STATS);
  el<HTMLSelectElement>("encoding-mode").value = selectedEncodingMode;
  el<HTMLInputElement>("clipboard-toggle").checked = clipboardEnabled;

  // Attach input listeners to the canvas
  canvas.setAttribute("tabindex", "0");
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  
  // Release all keys when window loses focus to prevent stuck keys
  window.addEventListener("blur", onWindowBlur);

  el("btn-connect").addEventListener("click", () => {
    if (connected) doDisconnect();
    else doConnect();
  });

  const settingsLink = document.getElementById("placeholder-settings-link") as HTMLAnchorElement | null;
  if (settingsLink) {
    if (getVsCodeApi() === undefined) {
      settingsLink.style.display = "none";
    } else {
      settingsLink.addEventListener("click", (event) => {
        event.preventDefault();
        getVsCodeApi()?.postMessage({ type: "vnc:openSettings" });
      });
    }
  }

  // Allow pressing Enter in the URL field to connect
  el("input-url").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && !connected) doConnect();
  });
  el("input-vnc-host").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && !connected) doConnect();
  });

  el<HTMLSelectElement>("encoding-mode").addEventListener("change", (e) => {
    selectedEncodingMode = (e.target as HTMLSelectElement).value as RfbEncodingMode;
    client?.setEncodingMode(selectedEncodingMode);
  });

  // Clipboard toggle
  el<HTMLInputElement>("clipboard-toggle").addEventListener("change", (e) => {
    const isChecked = (e.target as HTMLInputElement).checked;
    clipboardEnabled = isChecked;

    if (isChecked) {
      syncLocalClipboardToServerIfEnabled();
    }
  });

  // Monitor clipboard changes when enabled
  if (navigator.clipboard && navigator.clipboard.readText) {
    const pollClipboard = async () => {
      if (!clipboardEnabled || !connected) {
        setTimeout(pollClipboard, 1000);
        return;
      }
      
      try {
        const currentText = await navigator.clipboard.readText();
        if (currentText !== lastClipboardText) {
          lastClipboardText = currentText;
          if (client) {
            client.sendClipboardText(currentText);
          }
        }
      } catch (err) {
        // Silently fail on permission errors
      }
      
      setTimeout(pollClipboard, 1000); // Poll every second
    };
    
    pollClipboard();
  }

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
    if (!ENABLE_REMOTE_RESIZE) return;
    // Debounce resize to avoid spamming updates
    if (resizeTimeout !== null) clearTimeout(resizeTimeout);
    resizeTimeout = window.setTimeout(() => {
      const { width: viewportWidth, height: viewportHeight } = getPaintableViewportSize(main, canvas);
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

  // Request a fresh frame whenever this tab becomes visible again.
  document.addEventListener("visibilitychange", () => {
    updateVisibilityRefreshPolicy();
  });

  // Extension host notifies when the panel tab is exposed.
  window.addEventListener("message", (event) => {
    const msg = event.data as {
      type?: string;
      protocolOverride?: RfbEncodingMode;
      colorDepthOverride?: SessionColorDepth;
      clipboardEnabled?: boolean;
    } | undefined;
    if (msg?.type === "vnc:exposed") {
      forceRedraw();
      return;
    }
    if (msg?.type === "vnc:applyEndpointOverrides") {
      const nextProtocol = msg.protocolOverride ?? "auto";
      const encodingSelect = el<HTMLSelectElement>("encoding-mode");
      const protocolChanged = selectedEncodingMode !== nextProtocol;
      selectedEncodingMode = nextProtocol;
      encodingSelect.value = nextProtocol;

      sessionColorDepthOverride = msg.colorDepthOverride ?? null;
      if (sessionColorDepthOverride) {
        adaptiveColorDepth = sessionColorDepthOverride;
      }

      if (typeof msg.clipboardEnabled === "boolean") {
        clipboardEnabled = msg.clipboardEnabled;
        const clipboardToggle = el<HTMLInputElement>("clipboard-toggle");
        clipboardToggle.checked = clipboardEnabled;
        if (clipboardEnabled) {
          syncLocalClipboardToServerIfEnabled();
        }
      }

      if (nextProtocol === "auto") {
        adaptiveProtocolLocked = false;
        adaptiveProtocolEligible = adaptiveProtocolDepthEnabled;
        adaptiveConnectionStartTs = Date.now();
        lastAdaptiveSwitchTs = 0;
      }

      if (client && connected) {
        if (protocolChanged) {
          client.setEncodingMode(nextProtocol);
        }
        client.requestFramebufferUpdate(0, 0, undefined, undefined, false);
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
