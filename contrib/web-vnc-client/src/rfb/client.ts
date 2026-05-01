/**
 * RFB 3.8 protocol client over WebSocket.
 *
 * Connection flow:
 *   1. Version handshake
 *   2. Security negotiation (None or VNC Authentication)
 *   3. ClientInit / ServerInit
 *   4. SetPixelFormat  → 32 bpp, 24-bit RGB, red-shift=0
 *   5. SetEncodings    → Raw, CopyRect, Hextile, ZRLE, Tight + pseudo-encodings
 *   6. FramebufferUpdateRequest loop
 *
 * Pixel format requested: 32 bpp, depth 24, little-endian, true-colour.
 *   red-max=255, shift=0 → byte 0 of each pixel is R
 *   green-max=255, shift=8 → byte 1 is G
 *   blue-max=255, shift=16 → byte 2 is B
 *   byte 3 is unused padding
 *
 * This RGBA layout maps directly to CanvasRenderingContext2D ImageData with A=255.
 */
import { ByteReader } from "./byteReader";
import { readU16, readU32, readS32, concat } from "../utils";
import { encryptVncChallenge } from "../des";
import { applyHextile } from "../codecs/hextile";
import { ZrleDecoder } from "../codecs/zrle";
import { TightDecoder } from "../codecs/tight";
import { warmUpWasm } from "../codecs/tightInflateBackend";
import { applyH264, resetAllH264Contexts } from "../codecs/h264";

// ── RFB message / encoding constants ────────────────────────────────────────

const SECURITY_NONE     = 1;
const SECURITY_VNC_AUTH = 2;
const RFB_VERSION_3_3   = 3;
const RFB_VERSION_3_7   = 7;
const RFB_VERSION_3_8   = 8;

const MSG_FRAMEBUFFER_UPDATE  = 0;
const MSG_SET_COLOUR_MAP      = 1;
const MSG_BELL                = 2;
const MSG_SERVER_CUT_TEXT     = 3;

const ENC_RAW          =   0;
const ENC_COPYRECT     =   1;
const ENC_HEXTILE      =   5;
const ENC_ZRLE         =  16;
const ENC_TIGHT        =   7;
const ENC_H264         =  50;
const ENC_DESKTOP_SIZE = -223;
const ENC_CURSOR       = -239;
const ENC_QEMU_EXTENDED_KEY = -258;
const ENC_EXTENDED_DESKTOP_SIZE = -308;
const REMOTE_RESIZE_ACK_TIMEOUT_MS = 1500;

interface NonH264DecodeRequest {
  id: number;
  enc: number;
  w: number;
  h: number;
  payload: ArrayBuffer;
}

interface NonH264ResetRequest {
  type: "resetStateful";
}

interface NonH264DecodeResponse {
  id: number;
  ok: boolean;
  rgba?: ArrayBuffer;
  decodeMs?: number;
  tightProfile?: {
    subtype: "fill" | "jpeg" | "palette" | "gradient" | "truecolor";
    inflateMs: number;
    expandMs: number;
    jpegMs: number;
  };
  error?: string;
}

interface DecodedPatch {
  rgba: Uint8Array;
  decodeMs: number;
  tightProfile?: NonH264DecodeResponse["tightProfile"];
}

// ── Public API types ─────────────────────────────────────────────────────────

/** Represents a rectangular region updated in the framebuffer. */
export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Minimal transport interface. `WebSocket` satisfies this, as does any custom
 * adapter (e.g. a VS Code postMessage bridge).
 */
export interface RfbTransport {
  readyState: number;
  binaryType: string;
  onopen:    ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<ArrayBuffer>) => void) | null;
  onclose:   ((ev: CloseEvent) => void) | null;
  onerror:   ((ev: Event) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export interface RfbClientOptions {
  /**
   * WebSocket URL, e.g. "ws://localhost:5900".
   * Not required when a custom `transport` is provided.
   */
  url?: string;
  /**
   * Pre-built transport to use instead of opening a new WebSocket.
   * When provided, `url` is ignored.
   */
  transport?: RfbTransport;
  /** Optional VNC password (required when server uses VNC Authentication) */
  password?: string;
  /** Called each time a frame is ready; passes the updated canvas ImageData. */
  onFrame?: (imageData: ImageData) => void;
  /** Called after frame decode with dirty rectangles (high-performance path). */
  onFrameWithDirtyRects?: (imageData: ImageData, dirtyRects: DirtyRect[]) => void;
  /** Called when the remote desktop is resized. */
  onResize?: (width: number, height: number) => void;
  /** Called when the connection closes (cleanly or with error). */
  onDisconnect?: (reason: string) => void;
  /** Called with a status message string for UI display. */
  onStatus?: (msg: string) => void;
  /** Called when transport or decode stats change. */
  onStats?: (stats: RfbClientStats) => void;
  /** Called when server clipboard text is received. */
  onClipboard?: (text: string) => void;
  /** Called when a remote cursor shape update is received. */
  onCursor?: (cursorCss: string) => void;
  /** Preferred encoding policy for SetEncodings negotiation. */
  encodingMode?: RfbEncodingMode;
}

export interface RfbClientStats {
  encoding: string;
  colorDepth: string;
  receivedRate: number;
  updatesPerSecond: number;
  latencyMs: number;
  avgFrameMs: number;
  avgWorkerDecodeMs: number;
  avgBlitMs: number;
  tightWorkerBreakdown: string;
  workerQueueDepth: number;
  bottleneckHint: "server-limited" | "client-limited" | "balanced";
}

export type RfbEncodingMode = "auto" | "h264" | "tight" | "zrle" | "hextile" | "raw";

interface CursorShape {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  pixels: Uint8Array;
  mask: Uint8Array;
}

// ── Main client class ─────────────────────────────────────────────────────────

export class RfbClient {
  private ws: RfbTransport | null = null;
  private reader = new ByteReader();
  private opts: RfbClientOptions;
  private disconnectReason: string | null = null;

  private fbWidth = 0;
  private fbHeight = 0;
  private pixels!: Uint8Array;    // RGBA framebuffer
  private imageData!: ImageData;  // Wraps `pixels` for Canvas

  private zrle = new ZrleDecoder();
  private tight = new TightDecoder();

  private aborted = false;

  // Dirty rectangle tracking for current frame
  private dirtyRects: DirtyRect[] = [];

  // Desktop resize support tracking
  private supportsSetDesktopSize = false;
  private pendingRemoteResize = false;
  private queuedResizeWidth: number | null = null;
  private queuedResizeHeight: number | null = null;
  private framebufferUpdatesSeen = 0;
  private optimisticResizeAttempted = false;
  private resizeAckTimeout: number | null = null;
  private lastResize = 0;
  private pendingResizeScheduled = false;
  private pendingResizeTimer: number | null = null;
  private currentEncoding = "None";
  private receivedBytesWindow = 0;
  private statsTimer: number | null = null;
  private lastReceivedRate = 0;
  private updatesWindow = 0;
  private frameMsWindow = 0;
  private workerDecodeMsWindow = 0;
  private blitMsWindow = 0;
  private frameSamplesWindow = 0;
  private tightInflateMsWindow = 0;
  private tightExpandMsWindow = 0;
  private tightJpegMsWindow = 0;
  private lastUpdatesPerSecond = 0;
  private lastAvgFrameMs = 0;
  private lastAvgWorkerDecodeMs = 0;
  private lastAvgBlitMs = 0;
  private lastTightWorkerBreakdown = "-";
  private encodingMode: RfbEncodingMode;
  // When true, the next sendFbUpdateRequest call will send incremental=false
  // regardless of what the caller requests, then reset the flag.
  private pendingFullRefresh = false;
  private pendingPostConnectTightRefresh = false;

  // Encoding mode switch requested externally while a FBU was in progress.
  // Applied between complete FBUs to avoid corrupting stateful inflate streams.
  private pendingEncodingMode: RfbEncodingMode | null = null;

  // Frame timing optimization: adaptive request frequency
  private frameRequestTime: number | null = null;
  private frameRTT = 50;  // Estimated round-trip time (ms)
  private frameRTTAlpha = 0.2;  // EMA smoothing factor
  private lastFrameUpdateTime = 0;
  private frameRequestTimer: number | null = null;
  private minFrameInterval = 16;  // Minimum interval between requests (ms, ~60 FPS)
  private targetFrameRate = 60;  // Target frame rate (FPS)

  // Worker pool for non-H.264 decode to reduce main-thread CPU load.
  private nonH264Workers: Worker[] = [];
  private nonH264WorkerReady = false;
  private nextNonH264Worker = 0;
  private workerReqId = 1;
  private workerPending = new Map<number, {
    resolve: (patch: DecodedPatch) => void;
    reject: (error: unknown) => void;
  }>();

  constructor(opts: RfbClientOptions) {
    this.opts = opts;
    this.encodingMode = opts.encodingMode ?? "auto";
  }

  connect(): void {
    this.aborted = false;
    this.disconnectReason = null;
    this.pendingPostConnectTightRefresh = false;
    this.opts.onStatus?.("Connecting…");

    void warmUpWasm().then(() => {
      if (this.aborted) return;
      this.openWebSocket();
    });
  }

  private openWebSocket(): void {
    const ws: RfbTransport = this.opts.transport
      ?? new WebSocket(this.opts.url!, ["binary"]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.ensureNonH264Worker();
      this.opts.onStatus?.("Handshaking…");
      this.runProtocol().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.onStatus?.(`Error: ${msg}`);
        this.notifyDisconnect(msg);
        ws.close();
      });
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        this.receivedBytesWindow += ev.data.byteLength;
      }
      this.reader.push(ev.data as ArrayBuffer);
    };

    ws.onclose = (ev: CloseEvent) => {
      if (!this.aborted) {
        const reason = this.disconnectReason ?? (ev.reason || `code ${ev.code}`);
        this.notifyDisconnect(reason);
      }
    };

    ws.onerror = () => {
      this.notifyDisconnect("WebSocket error");
    };
  }

  disconnect(): void {
    this.aborted = true;
    this.stopStatsTimer();
    if (this.frameRequestTimer !== null) {
      window.clearTimeout(this.frameRequestTimer);
      this.frameRequestTimer = null;
    }
    this.shutdownNonH264Worker();
    this.ws?.close(1000, "User disconnect");
  }

  private ensureNonH264Worker(): void {
    if (this.nonH264Workers.length > 0 || this.nonH264WorkerReady) return;
    try {
      const cpuCount = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 2) : 2;
      const workerCount = Math.max(1, Math.min(4, cpuCount - 1));

      for (let i = 0; i < workerCount; i += 1) {
        const worker = new Worker(new URL("./nonH264DecodeWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (ev: MessageEvent<NonH264DecodeResponse>) => {
          const msg = ev.data;
          const pending = this.workerPending.get(msg.id);
          if (!pending) return;
          this.workerPending.delete(msg.id);
          if (msg.ok && msg.rgba) {
            pending.resolve({
              rgba: new Uint8Array(msg.rgba),
              decodeMs: msg.decodeMs ?? 0,
              tightProfile: msg.tightProfile,
            });
          } else {
            pending.reject(new Error(msg.error ?? "Decode worker failed"));
          }
        };
        worker.onerror = (ev: ErrorEvent) => {
          const err = ev.error ?? new Error(ev.message || "Decode worker error");
          for (const [, pending] of this.workerPending) {
            pending.reject(err);
          }
          this.workerPending.clear();
        };
        this.nonH264Workers.push(worker);
      }

      this.nonH264WorkerReady = this.nonH264Workers.length > 0;
      this.nextNonH264Worker = 0;
    } catch {
      // Fallback to local decode path when Worker is unavailable.
      this.nonH264Workers = [];
      this.nonH264WorkerReady = false;
      this.nextNonH264Worker = 0;
    }
  }

  private shutdownNonH264Worker(): void {
    for (const worker of this.nonH264Workers) {
      worker.terminate();
    }
    this.nonH264Workers = [];
    this.nonH264WorkerReady = false;
    this.nextNonH264Worker = 0;
    for (const [, pending] of this.workerPending) {
      pending.reject(new Error("Decode worker shutdown"));
    }
    this.workerPending.clear();
  }

  private resetNonH264StatefulWorkers(): void {
    if (!this.nonH264WorkerReady || this.nonH264Workers.length === 0) return;
    const req: NonH264ResetRequest = { type: "resetStateful" };
    // workers[0] owns stateful codecs (ZRLE/TIGHT). Reset all for safety.
    for (const worker of this.nonH264Workers) {
      worker.postMessage(req);
    }
  }

  private decodeNonH264WithWorker(enc: number, w: number, h: number, payload: Uint8Array): Promise<DecodedPatch> {
    if (!this.nonH264WorkerReady || this.nonH264Workers.length === 0) {
      return Promise.reject(new Error("Decode worker not available"));
    }
    const id = this.workerReqId++;
    const request: NonH264DecodeRequest = {
      id,
      enc,
      w,
      h,
      payload: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    };
    const statelessBase = this.nonH264Workers.length > 1 ? 1 : 0;
    const statelessCount = this.nonH264Workers.length - statelessBase;
    const workerIndex = statelessBase + (this.nextNonH264Worker % statelessCount);
    const worker = this.nonH264Workers[workerIndex]!;
    this.nextNonH264Worker = (this.nextNonH264Worker + 1) % statelessCount;
    return new Promise<DecodedPatch>((resolve, reject) => {
      this.workerPending.set(id, { resolve, reject });
      worker.postMessage(request, [request.payload]);
    });
  }

  // Stateful codecs (ZRLE, TIGHT) must always go to the same worker (workers[0])
  // so that their persistent inflate-stream state is preserved across rectangles.
  private decodeWithStatefulWorker(enc: number, w: number, h: number, payload: Uint8Array): Promise<DecodedPatch> {
    if (!this.nonH264WorkerReady || this.nonH264Workers.length === 0) {
      return Promise.reject(new Error("Decode worker not available"));
    }
    const id = this.workerReqId++;
    const request: NonH264DecodeRequest = { id, enc, w, h,
      payload: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    };
    const worker = this.nonH264Workers[0]!;
    return new Promise<DecodedPatch>((resolve, reject) => {
      this.workerPending.set(id, { resolve, reject });
      worker.postMessage(request, [request.payload]);
    });
  }

  private blitDecodedPatch(dstX: number, dstY: number, w: number, h: number, rgba: Uint8Array): void {
    for (let dy = 0; dy < h; dy += 1) {
      const srcOff = dy * w * 4;
      const dstOff = ((dstY + dy) * this.fbWidth + dstX) * 4;
      this.pixels.set(rgba.subarray(srcOff, srcOff + w * 4), dstOff);
    }
  }

  /** Send a keyboard event to the server. */
  sendKeyEvent(keysym: number, down: boolean): void {
    const msg = new Uint8Array(8);
    msg[0] = 4; // KeyEvent
    msg[1] = down ? 1 : 0;
    msg[4] = (keysym >>> 24) & 0xff;
    msg[5] = (keysym >>> 16) & 0xff;
    msg[6] = (keysym >>> 8) & 0xff;
    msg[7] = keysym & 0xff;
    this.send(msg);
  }

  /** Send a pointer (mouse) event to the server. */
  sendPointerEvent(x: number, y: number, buttonMask: number): void {
    const msg = new Uint8Array(6);
    msg[0] = 5; // PointerEvent
    msg[1] = buttonMask;
    msg[2] = (x >> 8) & 0xff;
    msg[3] = x & 0xff;
    msg[4] = (y >> 8) & 0xff;
    msg[5] = y & 0xff;
    this.send(msg);
  }

  /** Send clipboard text to the server (ClientCutText message, type 6). */
  sendClipboardText(text: string): void {
    // Encode the text as UTF-8 bytes
    const textBytes = new TextEncoder().encode(text);
    
    // Build the ClientCutText message:
    // Type: 6 (1 byte)
    // Padding: 3 bytes
    // Length: 4 bytes (big-endian)
    // Data: length bytes
    const msg = new Uint8Array(8 + textBytes.length);
    msg[0] = 6; // ClientCutText message type
    // msg[1-3] are padding (already 0)
    msg[4] = (textBytes.length >>> 24) & 0xff;
    msg[5] = (textBytes.length >>> 16) & 0xff;
    msg[6] = (textBytes.length >>> 8) & 0xff;
    msg[7] = textBytes.length & 0xff;
    msg.set(textBytes, 8);
    
    this.send(msg);
  }

  /** Request server to resize the desktop. */
  setDesktopSize(width: number, height: number): void {
    const msg = new Uint8Array(24);
    msg[0] = 251;           // ClientSetDesktopSize message type
    msg[1] = 0;             // padding
    msg[2] = (width >> 8) & 0xff;
    msg[3] = width & 0xff;
    msg[4] = (height >> 8) & 0xff;
    msg[5] = height & 0xff;
    msg[6] = 1;             // number-of-screens
    msg[7] = 0;             // padding
    
    // Screen 0 (the main screen)
    msg[8] = 0;             // screen id (4 bytes, big-endian)
    msg[9] = 0;
    msg[10] = 0;
    msg[11] = 0;
    msg[12] = 0;            // x-position
    msg[13] = 0;
    msg[14] = 0;            // y-position
    msg[15] = 0;
    msg[16] = (width >> 8) & 0xff;   // width
    msg[17] = width & 0xff;
    msg[18] = (height >> 8) & 0xff;  // height
    msg[19] = height & 0xff;
    msg[20] = 0;            // flags (4 bytes, big-endian)
    msg[21] = 0;
    msg[22] = 0;
    msg[23] = 0;
    this.send(msg);
  }

  /** Request a framebuffer update for the specified region. */
  requestFramebufferUpdate(
    x: number = 0,
    y: number = 0,
    width?: number,
    height?: number,
    incremental: boolean = false
  ): void {
    width = width ?? this.fbWidth;
    height = height ?? this.fbHeight;
    this.sendFbUpdateRequest(incremental, x, y, width, height);
  }

  setTargetFrameRate(fps: number): void {
    this.targetFrameRate = Math.max(0.2, fps);
  }

  /**
   * Request the server to resize the remote desktop.
   * Must wait for ExtendedDesktopSize support confirmation before calling.
   * Implements rate limiting (100ms minimum between requests) and deduplication.
   */
  requestRemoteResize(width: number, height: number): void {
    // Always remember the latest requested target so it can be retried later.
    this.queuedResizeWidth = width;
    this.queuedResizeHeight = height;

    // Guard 1: Server must support ExtendedDesktopSize
    if (!this.supportsSetDesktopSize) {
      // Some servers expose support lazily; force a few full updates to speed discovery.
      this.pendingFullRefresh = true;
      return;
    }

    // Guard 2: Skip if size hasn't changed
    if (width === this.fbWidth && height === this.fbHeight) {
      this.queuedResizeWidth = null;
      this.queuedResizeHeight = null;
      return;
    }

    // Guard 3: Skip if resize already in flight
    if (this.pendingRemoteResize) {
      return;
    }

    // Guard 4: Rate limit - enforce 100ms minimum between resize requests
    const now = Date.now();
    const elapsed = now - this.lastResize;
    if (elapsed < 100) {
      // Schedule a retry after the rate limit period
      if (!this.pendingResizeScheduled) {
        this.pendingResizeScheduled = true;
        this.pendingResizeTimer = window.setTimeout(() => {
          this.pendingResizeScheduled = false;
          this.flushQueuedRemoteResize();
        }, 100 - elapsed);
      }
      return;
    }

    // All guards passed - proceed with resize request
    this.pendingRemoteResize = true;
    this.lastResize = now;
    this.queuedResizeWidth = null;
    this.queuedResizeHeight = null;
    
    this.setDesktopSize(width, height);
    this.armResizeAckTimeout();
    
    // Also request a full framebuffer update to see the resized desktop
    this.requestFramebufferUpdate(0, 0, width, height, false);
  }

  private armResizeAckTimeout(): void {
    this.clearResizeAckTimeout();
    this.resizeAckTimeout = window.setTimeout(() => {
      // If no desktop-size style acknowledgement arrives, release in-flight state.
      this.pendingRemoteResize = false;
      this.resizeAckTimeout = null;
      this.flushQueuedRemoteResize();
    }, REMOTE_RESIZE_ACK_TIMEOUT_MS);
  }

  private clearResizeAckTimeout(): void {
    if (this.resizeAckTimeout !== null) {
      window.clearTimeout(this.resizeAckTimeout);
      this.resizeAckTimeout = null;
    }
  }

  private flushQueuedRemoteResize(): void {
    if (this.queuedResizeWidth === null || this.queuedResizeHeight === null) {
      return;
    }
    const width = this.queuedResizeWidth;
    const height = this.queuedResizeHeight;
    this.requestRemoteResize(width, height);
  }

  private maybeAttemptOptimisticResize(): void {
    if (this.supportsSetDesktopSize) return;
    if (this.optimisticResizeAttempted) return;
    if (this.pendingRemoteResize) return;
    if (this.queuedResizeWidth === null || this.queuedResizeHeight === null) return;
    if (this.framebufferUpdatesSeen < 3) return;

    const width = this.queuedResizeWidth;
    const height = this.queuedResizeHeight;

    // One fallback attempt for servers that support resize but never advertise via pseudo-rects.
    this.optimisticResizeAttempted = true;
    this.pendingRemoteResize = true;
    this.lastResize = Date.now();
    this.setDesktopSize(width, height);
    this.armResizeAckTimeout();
    this.requestFramebufferUpdate(0, 0, width, height, false);
  }

  setEncodingMode(mode: RfbEncodingMode): void {
    // Defer the actual switch until the current FBU (if any) is fully parsed.
    // Applying it mid-FBU would reset inflate state while the reader still holds
    // buffered bytes in the old encoding, corrupting the stream.
    this.pendingEncodingMode = mode;
  }

  private applyEncodingMode(mode: RfbEncodingMode): void {
    this.encodingMode = mode;
    // Reset decoder state so the new stream gets a clean handshake.
    this.tight.reset();
    this.zrle.reset();
    resetAllH264Contexts();
    this.resetNonH264StatefulWorkers();
    if (this.ws?.readyState === /* OPEN */ 1) {
      this.sendSetEncodings();
      // Signal the main loop to send a non-incremental FBU on its next cycle
      // so the server delivers a complete fresh frame in the new encoding.
      this.pendingFullRefresh = true;
    }
  }
  // ── Internal helpers ───────────────────────────────────────────────────────

  private send(data: Uint8Array): void {
    if (this.ws?.readyState === /* OPEN */ 1) {
      this.ws.send(data);
    }
  }

  private notifyDisconnect(reason: string): void {
    if (this.disconnectReason !== null) return;
    this.stopStatsTimer();
    this.disconnectReason = reason;
    this.opts.onDisconnect?.(reason);
  }

  private async runProtocol(): Promise<void> {
    await this.handshake();
    if (this.aborted) return;
    await this.mainLoop();
  }

  // ── Handshake ─────────────────────────────────────────────────────────────

  private async handshake(): Promise<void> {
    // 1. Read server version (12 bytes: "RFB 003.008\n")
    const serverVer = await this.reader.read(12);
    const verStr = new TextDecoder().decode(serverVer);
    if (!verStr.startsWith("RFB ")) {
      throw new Error(`Unexpected server version: ${verStr.trim()}`);
    }

    const match = /^RFB 003\.(\d{3})\n$/.exec(verStr);
    if (!match) {
      throw new Error(`Unsupported server version: ${verStr.trim()}`);
    }

    const serverMinor = Number(match[1]);
    const clientMinor = serverMinor >= RFB_VERSION_3_8
      ? RFB_VERSION_3_8
      : serverMinor >= RFB_VERSION_3_7
        ? RFB_VERSION_3_7
        : RFB_VERSION_3_3;

    // 2. Send client version
    this.send(new TextEncoder().encode(`RFB 003.${clientMinor.toString().padStart(3, "0")}\n`));

    // 3. Security negotiation
    let chosenType = 0;
    if (clientMinor >= RFB_VERSION_3_7) {
      const numTypesArr = await this.reader.read(1);
      const numTypes = numTypesArr[0]!;
      if (numTypes === 0) {
        const lenArr = await this.reader.read(4);
        const len = readU32(lenArr, 0);
        const msgArr = await this.reader.read(len);
        throw new Error(`Server error: ${new TextDecoder().decode(msgArr)}`);
      }

      const secTypes = await this.reader.read(numTypes);
      for (const t of secTypes) {
        if (t === SECURITY_NONE) { chosenType = SECURITY_NONE; break; }
      }
      if (chosenType === 0) {
        for (const t of secTypes) {
          if (t === SECURITY_VNC_AUTH) { chosenType = SECURITY_VNC_AUTH; break; }
        }
      }
      if (chosenType === 0) {
        throw new Error(`No supported security type (server offers: ${Array.from(secTypes).join(",")})`);
      }

      this.send(new Uint8Array([chosenType]));
    } else {
      const secTypeArr = await this.reader.read(4);
      chosenType = readU32(secTypeArr, 0);
      if (chosenType === 0) {
        const lenArr = await this.reader.read(4);
        const len = readU32(lenArr, 0);
        const msgArr = await this.reader.read(len);
        throw new Error(`Server error: ${new TextDecoder().decode(msgArr)}`);
      }
      if (chosenType !== SECURITY_NONE && chosenType !== SECURITY_VNC_AUTH) {
        throw new Error(`No supported security type (server offers: ${chosenType})`);
      }
    }

    // 4. VNC Authentication challenge-response
    if (chosenType === SECURITY_VNC_AUTH) {
      const challenge = await this.reader.read(16);
      const password = this.opts.password ?? "";
      const response = encryptVncChallenge(challenge, password);
      this.send(response);
    }

    // 5. Security result
    if (clientMinor >= RFB_VERSION_3_7 || chosenType === SECURITY_VNC_AUTH) {
      const resultArr = await this.reader.read(4);
      const result = readU32(resultArr, 0);
      if (result !== 0) {
        const lenArr = await this.reader.read(4);
        const len = readU32(lenArr, 0);
        const msgArr = await this.reader.read(len);
        throw new Error(`Auth failed: ${new TextDecoder().decode(msgArr)}`);
      }
    }

    // 6. ClientInit (shared = 0 so this session requests exclusive access)
    this.send(new Uint8Array([0]));

    // 7. ServerInit: width(2) + height(2) + pixel-format(16) + name-length(4) + name
    const serverInitHdr = await this.reader.read(24);
    this.fbWidth  = readU16(serverInitHdr, 0);
    this.fbHeight = readU16(serverInitHdr, 2);
    const nameLen = readU32(serverInitHdr, 20);
    await this.reader.read(nameLen); // discard name for now

    this.allocateFramebuffer(this.fbWidth, this.fbHeight);
    this.opts.onResize?.(this.fbWidth, this.fbHeight);
    this.opts.onStatus?.("Connected");
    this.startStatsTimer();
    this.emitStats();

    // 8. SetPixelFormat – request 32 bpp RGBX
    this.sendSetPixelFormat();

    // 9. SetEncodings
    this.sendSetEncodings();

    // 10. Initial full framebuffer request
    this.sendFbUpdateRequest(false, 0, 0, this.fbWidth, this.fbHeight);
    this.pendingPostConnectTightRefresh = this.encodingMode === "tight";
  }

  // ── Main message loop ──────────────────────────────────────────────────────

  private async mainLoop(): Promise<void> {
    while (!this.aborted) {
      const typeArr = await this.reader.read(1);
      const type = typeArr[0]!;

      if (type === MSG_FRAMEBUFFER_UPDATE) {
        await this.parseFramebufferUpdate();
      } else if (type === MSG_SET_COLOUR_MAP) {
        await this.skipSetColourMap();
      } else if (type === MSG_BELL) {
        // ignore
      } else if (type === MSG_SERVER_CUT_TEXT) {
        await this.handleServerCutText();
      } else {
        throw new Error(`Unknown server message type: ${type}`);
      }
    }
  }

  // ── FramebufferUpdate ─────────────────────────────────────────────────────

  private async parseFramebufferUpdate(): Promise<void> {
    try {
    const decodeStart = performance.now();
    const hdr = await this.reader.read(3); // pad(1) + numRects(2)
    const numRects = readU16(hdr, 1);
    this.framebufferUpdatesSeen += 1;
    this.updatesWindow += 1;

    // Track frame timing for adaptive request frequency
    const frameArrivalTime = Date.now();
    if (this.frameRequestTime !== null) {
      const rtt = frameArrivalTime - this.frameRequestTime;
      // Smooth RTT estimate using exponential moving average
      this.frameRTT = this.frameRTTAlpha * rtt + (1 - this.frameRTTAlpha) * this.frameRTT;
    }

    // Reset dirty rects for this frame
    this.dirtyRects = [];

    let frameWorkerDecodeMs = 0;
    let frameBlitMs = 0;

    const pendingParallelRects: Array<{
      x: number;
      y: number;
      w: number;
      h: number;
      promise: Promise<DecodedPatch>;
    }> = [];

    const flushParallelRects = async (): Promise<void> => {
      for (const pending of pendingParallelRects) {
        const patch = await pending.promise;
        frameWorkerDecodeMs += patch.decodeMs;
        if (patch.tightProfile) {
          this.tightInflateMsWindow += patch.tightProfile.inflateMs;
          this.tightExpandMsWindow += patch.tightProfile.expandMs;
          this.tightJpegMsWindow += patch.tightProfile.jpegMs;
        }
        const blitStart = performance.now();
        this.blitDecodedPatch(pending.x, pending.y, pending.w, pending.h, patch.rgba);
        frameBlitMs += performance.now() - blitStart;
        this.trackDirtyRect(pending.x, pending.y, pending.w, pending.h);
      }
      pendingParallelRects.length = 0;
    };

    for (let i = 0; i < numRects; i += 1) {
      const rectHdr = await this.reader.read(12);
      const x   = readU16(rectHdr, 0);
      const y   = readU16(rectHdr, 2);
      const w   = readU16(rectHdr, 4);
      const h   = readU16(rectHdr, 6);
      const enc = readS32(rectHdr, 8);

      // Parallelize decodable rects off the main thread.
      // Stateless (RAW, HEXTILE): round-robin across all workers.
      // Stateful (ZRLE, TIGHT): always dispatched to workers[0] in order
      //   so persistent inflate-stream state is preserved correctly.
      // CopyRect and pseudo-encodings fall through to applyRect.
      if (this.nonH264WorkerReady && (enc === ENC_RAW || enc === ENC_HEXTILE)) {
        const payload = enc === ENC_RAW
          ? await this.reader.read(w * h * 4)
          : await this.readHextile(w, h);
        pendingParallelRects.push({
          x, y, w, h,
          promise: this.decodeNonH264WithWorker(enc, w, h, payload),
        });
        continue;
      }

      if (this.nonH264WorkerReady && enc === ENC_ZRLE) {
        const lenArr = await this.reader.read(4);
        const compLen = readU32(lenArr, 0);
        const compData = await this.reader.read(compLen);
        pendingParallelRects.push({
          x, y, w, h,
          promise: this.decodeWithStatefulWorker(enc, w, h, compData),
        });
        continue;
      }

      if (this.nonH264WorkerReady && enc === ENC_TIGHT) {
        const data = await this.readTight(w, h);
        pendingParallelRects.push({
          x, y, w, h,
          promise: this.decodeWithStatefulWorker(enc, w, h, data),
        });
        continue;
      }

      if (pendingParallelRects.length > 0) {
        await flushParallelRects();
      }

      await this.applyRect(x, y, w, h, enc);
    }

    if (pendingParallelRects.length > 0) {
      await flushParallelRects();
    }

    // Commit frame to canvas with dirty rect information
    if (this.opts.onFrameWithDirtyRects) {
      this.opts.onFrameWithDirtyRects(this.imageData, this.dirtyRects);
    } else {
      this.opts.onFrame?.(this.imageData);
    }

    // Fallback path if resize capability has not been explicitly discovered.
    this.maybeAttemptOptimisticResize();

    const frameMs = performance.now() - decodeStart;
    this.frameMsWindow += frameMs;
    this.workerDecodeMsWindow += frameWorkerDecodeMs;
    this.blitMsWindow += frameBlitMs;
    this.frameSamplesWindow += 1;

    // Apply any encoding-mode change that was scheduled while this FBU was
    // in progress. Doing it here guarantees the reader is at a clean message
    // boundary, so the next FBU will be in the new encoding from the start.
    if (this.pendingEncodingMode !== null) {
      const m = this.pendingEncodingMode;
      this.pendingEncodingMode = null;
      this.applyEncodingMode(m);
    }
    if (this.pendingPostConnectTightRefresh) {
      this.pendingPostConnectTightRefresh = false;
      this.sendFbUpdateRequest(false, 0, 0, this.fbWidth, this.fbHeight);
    } else {
      // Request the next update only after any pending encoding switch has been
      // applied at this message boundary.
      this.sendAdaptiveFramebufferUpdateRequest();
    }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // A decode failure inside FramebufferUpdate can leave unread rectangles
      // in the current server message. Because some encodings are not
      // length-delimited on the wire, we cannot reliably resync in-place.
      // Fail fast so the session can reconnect from a clean protocol boundary.
      this.opts.onStatus?.(`Decode error: ${msg}`);
      throw new Error(`Framebuffer decode failed (resync requires reconnect): ${msg}`);
    }
  }

  /**
   * Send framebuffer update request with adaptive timing.
   * Throttles requests based on estimated network RTT to avoid overwhelming the server
   * and to reduce input-to-display latency by pacing updates.
   */
  private sendAdaptiveFramebufferUpdateRequest(): void {
    const now = Date.now();
    const timeSinceLastFrame = now - this.lastFrameUpdateTime;
    
    // Prefer target-rate pacing. RTT-based guarding can strongly under-drive
    // update throughput on higher-latency links and cap observed FPS.
    const targetInterval = Math.max(this.minFrameInterval, 1000 / this.targetFrameRate);
    const adaptiveInterval = targetInterval;
    
    if (timeSinceLastFrame >= adaptiveInterval) {
      // Sufficient time has passed, send request immediately
      if (this.frameRequestTimer !== null) {
        window.clearTimeout(this.frameRequestTimer);
        this.frameRequestTimer = null;
      }
      this.frameRequestTime = now;
      this.lastFrameUpdateTime = now;
      this.sendFbUpdateRequest(true, 0, 0, this.fbWidth, this.fbHeight);
    } else {
      // Schedule request for later
      const delayMs = adaptiveInterval - timeSinceLastFrame;
      if (this.frameRequestTimer !== null) {
        window.clearTimeout(this.frameRequestTimer);
      }
      this.frameRequestTimer = window.setTimeout(() => {
        this.frameRequestTimer = null;
        if (!this.aborted) {
          this.frameRequestTime = Date.now();
          this.lastFrameUpdateTime = Date.now();
          this.sendFbUpdateRequest(true, 0, 0, this.fbWidth, this.fbHeight);
        }
      }, delayMs);
    }
  }

  private trackDirtyRect(x: number, y: number, w: number, h: number): void {
    // Merge with existing dirty rects if they overlap (simple approach: just add)
    // A more sophisticated implementation could merge overlapping rects
    if (w > 0 && h > 0) {
      this.dirtyRects.push({ x, y, width: w, height: h });
    }
  }

  private async applyRect(x: number, y: number, w: number, h: number, enc: number): Promise<void> {
    this.currentEncoding = encodingName(enc);
    this.emitStats();

    if (enc === ENC_RAW) {
      const data = await this.reader.read(w * h * 4);
      // Pixel format: RGBX (4 bytes; byte 3 is padding)
      for (let dy = 0; dy < h; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) {
          const si = (dy * w + dx) * 4;
          const di = ((y + dy) * this.fbWidth + (x + dx)) * 4;
          this.pixels[di]     = data[si]!;
          this.pixels[di + 1] = data[si + 1]!;
          this.pixels[di + 2] = data[si + 2]!;
          this.pixels[di + 3] = 255;
        }
      }
      this.trackDirtyRect(x, y, w, h);
      return;
    }

    if (enc === ENC_COPYRECT) {
      const cr = await this.reader.read(4);
      const srcX = readU16(cr, 0);
      const srcY = readU16(cr, 2);
      const temp = new Uint8Array(w * 4);
      for (let dy = 0; dy < h; dy += 1) {
        const srcOff = ((srcY + dy) * this.fbWidth + srcX) * 4;
        const dstOff = ((y + dy) * this.fbWidth + x) * 4;
        temp.set(this.pixels.subarray(srcOff, srcOff + w * 4));
        this.pixels.set(temp, dstOff);
      }
      this.trackDirtyRect(x, y, w, h);
      return;
    }

    if (enc === ENC_HEXTILE) {
      // Hextile length is not sent in the wire; we read tile-by-tile.
      // Accumulate an estimate and read lazily.
      const data = await this.readHextile(w, h);
      applyHextile(this.pixels, this.fbWidth, x, y, w, h, data);
      this.trackDirtyRect(x, y, w, h);
      return;
    }

    if (enc === ENC_ZRLE) {
      const lenArr = await this.reader.read(4);
      const compLen = readU32(lenArr, 0);
      const compData = await this.reader.read(compLen);
      this.zrle.applyRect(compData, this.pixels, this.fbWidth, x, y, w, h);
      this.trackDirtyRect(x, y, w, h);
      return;
    }

    if (enc === ENC_TIGHT) {
      const data = await this.readTight(w, h);
      const result = this.tight.applyRect(data, this.pixels, this.fbWidth, x, y, w, h);
      if (result instanceof Promise) await result;
      this.trackDirtyRect(x, y, w, h);
      return;
    }
    if (enc === ENC_H264) {
      // H.264 encoding: 4-byte length + 4-byte flags + H.264 frame data
      const lenArr = await this.reader.read(4);
      const frameLen = readU32(lenArr, 0);
      const flagsArr = await this.reader.read(4);
      const flags = readU32(flagsArr, 0);
      const frameData = await this.reader.read(frameLen);
      await applyH264(frameData, this.pixels, this.fbWidth, x, y, w, h, flags);
      this.trackDirtyRect(x, y, w, h);
      return;
    }

    if (enc === ENC_DESKTOP_SIZE) {
      this.fbWidth  = w;
      this.fbHeight = h;
      this.allocateFramebuffer(w, h);
      // Keep ZRLE/Tight zlib history across DesktopSize. Some servers continue
      // the same stream after resize, and resetting here causes inflate
      // failures like "invalid distance".
      resetAllH264Contexts();
      this.opts.onResize?.(w, h);
      this.pendingRemoteResize = false;
      this.clearResizeAckTimeout();
      this.flushQueuedRemoteResize();
      return;
    }

    if (enc === ENC_EXTENDED_DESKTOP_SIZE) {
      // ExtendedDesktopSize includes a screen layout payload after the rectangle header.
      this.supportsSetDesktopSize = true;

      const header = await this.reader.read(4);
      const screenCount = header[0]!;
      await this.reader.read(screenCount * 16);

      if (x === 1 && y !== 0) {
        const errorCodes: Record<number, string> = {
          1: "Admin prohibited",
          2: "Out of resources",
          3: "Invalid layout",
        };
        this.opts.onStatus?.(`Desktop resize failed: ${errorCodes[y] ?? `Error code ${y}`}`);
        this.pendingRemoteResize = false;
        this.clearResizeAckTimeout();
        return;
      }

      this.fbWidth = w;
      this.fbHeight = h;
      this.allocateFramebuffer(w, h);
      // Keep ZRLE/Tight zlib history across ExtendedDesktopSize for stream
      // continuity (servers may continue the same compressed stream).
      resetAllH264Contexts();
      this.opts.onResize?.(w, h);

      // Treat any ExtendedDesktopSize update as an acknowledgement boundary.
      this.pendingRemoteResize = false;
      this.clearResizeAckTimeout();
      this.flushQueuedRemoteResize();
      return;
    }

    if (enc === ENC_CURSOR) {
      // Cursor pseudo-encoding: w*h*4 + ceil(w*h/8) mask bytes
      const pixelBytes = w * h * 4;
      const maskBytes  = Math.floor((w + 7) / 8) * h;
      const payload = await this.reader.read(pixelBytes + maskBytes);
      const pixels = payload.subarray(0, pixelBytes);
      const mask = payload.subarray(pixelBytes);
      const cursorCss = this.buildCursorCss({
        width: w,
        height: h,
        hotspotX: x,
        hotspotY: y,
        pixels,
        mask,
      });
      this.opts.onCursor?.(cursorCss);
      return;
    }

    // Unknown encoding – we can't skip because length is unspecified.
    throw new Error(`Unsupported encoding: ${enc}`);
  }

  // ── Hextile streaming reader ──────────────────────────────────────────────
  //
  // Hextile doesn't include a payload length – the client must parse the
  // tile stream to know how much data belongs to the rectangle.

  private async readHextile(w: number, h: number): Promise<Uint8Array> {
    const tilesX = Math.ceil(w / 16);
    const tilesY = Math.ceil(h / 16);
    const chunks: Uint8Array[] = [];

    for (let tileRow = 0; tileRow < tilesY; tileRow += 1) {
      for (let tileCol = 0; tileCol < tilesX; tileCol += 1) {
        const tileW = Math.min(16, w - tileCol * 16);
        const tileH = Math.min(16, h - tileRow * 16);

        const subArr = await this.reader.read(1);
        const sub = subArr[0]!;
        chunks.push(subArr);

        if ((sub & 0x01) !== 0) {
          // RAW tile
          const rawData = await this.reader.read(tileW * tileH * 4);
          chunks.push(rawData);
          continue;
        }

        if ((sub & 0x02) !== 0) {
          chunks.push(await this.reader.read(4)); // background colour (RGBX)
        }
        if ((sub & 0x04) !== 0) {
          chunks.push(await this.reader.read(4)); // foreground colour (RGBX)
        }
        if ((sub & 0x08) !== 0) {
          const countArr = await this.reader.read(1);
          const count = countArr[0]!;
          chunks.push(countArr);
          const coloured = (sub & 0x10) !== 0;
          const bytesPerSubrect = coloured ? 6 : 2; // colour(4) + xy(1) + wh(1) vs xy+wh
          chunks.push(await this.reader.read(count * bytesPerSubrect));
        }
      }
    }

    return concat(...chunks);
  }

  // ── Tight streaming reader ─────────────────────────────────────────────────
  //
  // Tight payloads are self-delimiting; we parse the control byte to know
  // how many bytes to read.

  private async readTight(w: number, h: number): Promise<Uint8Array> {
    const ctrlArr = await this.reader.read(1);
    const ctrl = ctrlArr[0]!;
    const tightType = (ctrl >> 4) & 0x0f;

    if (tightType === 0x08) {
      // Fill: 3 bytes colour
      const colorData = await this.reader.read(3);
      return concat(ctrlArr, colorData);
    }

    if (tightType === 0x09) {
      // JPEG: compact-length + data
      return concat(ctrlArr, await this.readTightCompactData());
    }

    // Basic / gradient / palette
    const extraChunks: Uint8Array[] = [ctrlArr];
    let paletteSize = 0;

    if ((tightType & 0x04) !== 0) {
      // Explicit filter byte
      const filterArr = await this.reader.read(1);
      extraChunks.push(filterArr);
      const filterId = filterArr[0]!;
      if (filterId === 0x01) {
        // Palette: size byte + palette entries
        const szArr = await this.reader.read(1);
        extraChunks.push(szArr);
        paletteSize = szArr[0]! + 1;
        const paletteData = await this.reader.read(paletteSize * 3);
        extraChunks.push(paletteData);
      }
    }

    const rowSize = paletteSize > 0
      ? (paletteSize <= 2 ? Math.floor((w + 7) / 8) : w)
      : w * 3;
    const dataSize = h * rowSize;

    if (dataSize >= 12) {
      const compData = await this.readTightCompactData();
      return concat(...extraChunks, compData);
    } else {
      const rawData = await this.reader.read(dataSize);
      return concat(...extraChunks, rawData);
    }
  }

  private async readTightCompactData(): Promise<Uint8Array> {
    // Read compact-length then that many bytes, return both together
    const bytes: Uint8Array[] = [];
    let len = 0;

    const b0Arr = await this.reader.read(1);
    bytes.push(b0Arr);
    const b0 = b0Arr[0]!;
    len = b0 & 0x7f;
    if ((b0 & 0x80) !== 0) {
      const b1Arr = await this.reader.read(1);
      bytes.push(b1Arr);
      const b1 = b1Arr[0]!;
      len |= (b1 & 0x7f) << 7;
      if ((b1 & 0x80) !== 0) {
        const b2Arr = await this.reader.read(1);
        bytes.push(b2Arr);
        len |= b2Arr[0]! << 14;
      }
    }

    bytes.push(await this.reader.read(len));
    return concat(...bytes);
  }

  // ── Skip handlers ──────────────────────────────────────────────────────────

  private async skipSetColourMap(): Promise<void> {
    const hdr = await this.reader.read(5); // pad(1) + first-colour(2) + num-colours(2)
    const numColours = readU16(hdr, 3);
    await this.reader.read(numColours * 6);
  }

  private async handleServerCutText(): Promise<void> {
    const hdr = await this.reader.read(7); // pad(3) + length(4)
    const length = readU32(hdr, 3);
    const data = await this.reader.read(length);
    const text = new TextDecoder().decode(data);
    this.opts.onClipboard?.(text);
  }

  private buildCursorCss(shape: CursorShape): string {
    const { width, height, hotspotX, hotspotY, pixels, mask } = shape;
    // Some servers send an empty cursor shape (0x0) to hide or reset cursor.
    // Avoid createImageData(0, 0), which throws in browsers.
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return "default";
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "default";

    const imageData = ctx.createImageData(width, height);
    const rowMaskBytes = Math.floor((width + 7) / 8);

    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const i = (py * width + px) * 4;
        const maskByte = mask[py * rowMaskBytes + (px >> 3)]!;
        const bit = 7 - (px & 7);
        const visible = ((maskByte >> bit) & 1) !== 0;

        imageData.data[i] = pixels[i]!;
        imageData.data[i + 1] = pixels[i + 1]!;
        imageData.data[i + 2] = pixels[i + 2]!;
        imageData.data[i + 3] = visible ? 255 : 0;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    return `url("${dataUrl}") ${hotspotX} ${hotspotY}, default`;
  }

  // ── Outgoing messages ──────────────────────────────────────────────────────

  private sendSetPixelFormat(): void {
    // SetPixelFormat: type(1) + pad(3) + pixel-format(16)
    const msg = new Uint8Array(20);
    msg[0] = 0; // SetPixelFormat
    // pixel-format at offset 4:
    msg[4]  = 32;  // bits-per-pixel
    msg[5]  = 24;  // depth
    msg[6]  = 0;   // big-endian-flag (false = little-endian)
    msg[7]  = 1;   // true-colour-flag
    msg[8]  = 0;   msg[9]  = 255; // red-max
    msg[10] = 0;   msg[11] = 255; // green-max
    msg[12] = 0;   msg[13] = 255; // blue-max
    msg[14] = 0;  // red-shift
    msg[15] = 8;  // green-shift
    msg[16] = 16; // blue-shift
    this.send(msg);
  }

  private sendSetEncodings(): void {
    const encs = preferredEncodingsForMode(this.encodingMode);
    encs.push(
      ENC_COPYRECT,
      ENC_RAW,
      ENC_DESKTOP_SIZE,
      ENC_CURSOR,
      ENC_EXTENDED_DESKTOP_SIZE,
    );

    const uniqueEncs = [...new Set(encs)];

    const msg = new Uint8Array(4 + uniqueEncs.length * 4);
    msg[0] = 2; // SetEncodings
    msg[3] = uniqueEncs.length;
    for (let i = 0; i < uniqueEncs.length; i += 1) {
      const enc = uniqueEncs[i]!;
      const off = 4 + i * 4;
      msg[off]     = (enc >>> 24) & 0xff;
      msg[off + 1] = (enc >>> 16) & 0xff;
      msg[off + 2] = (enc >>> 8)  & 0xff;
      msg[off + 3] = enc & 0xff;
    }
    this.send(msg);
  }

  private sendFbUpdateRequest(
    incremental: boolean,
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    if (this.pendingFullRefresh) {
      incremental = false;
      this.pendingFullRefresh = false;
    }
    const msg = new Uint8Array(10);
    msg[0] = 3; // FramebufferUpdateRequest
    msg[1] = incremental ? 1 : 0;
    msg[2] = (x >> 8) & 0xff;
    msg[3] = x & 0xff;
    msg[4] = (y >> 8) & 0xff;
    msg[5] = y & 0xff;
    msg[6] = (w >> 8) & 0xff;
    msg[7] = w & 0xff;
    msg[8] = (h >> 8) & 0xff;
    msg[9] = h & 0xff;
    this.send(msg);
  }

  // ── Framebuffer allocation ─────────────────────────────────────────────────

  private allocateFramebuffer(w: number, h: number): void {
    this.pixels = new Uint8Array(w * h * 4);
    // Initialize with opaque black
    for (let i = 3; i < this.pixels.length; i += 4) {
      this.pixels[i] = 255;
    }
    this.imageData = new ImageData(
      // Share the same backing buffer (no copy)
      new Uint8ClampedArray(this.pixels.buffer as ArrayBuffer),
      w,
      h
    );
  }

  private startStatsTimer(): void {
    this.stopStatsTimer();
    this.statsTimer = window.setInterval(() => {
      const receivedRate = this.receivedBytesWindow;
      this.receivedBytesWindow = 0;
      this.lastReceivedRate = receivedRate;
      this.lastUpdatesPerSecond = this.updatesWindow;
      this.updatesWindow = 0;
      if (this.frameSamplesWindow > 0) {
        this.lastAvgFrameMs = this.frameMsWindow / this.frameSamplesWindow;
        this.lastAvgWorkerDecodeMs = this.workerDecodeMsWindow / this.frameSamplesWindow;
        this.lastAvgBlitMs = this.blitMsWindow / this.frameSamplesWindow;
      } else {
        this.lastAvgFrameMs = 0;
        this.lastAvgWorkerDecodeMs = 0;
        this.lastAvgBlitMs = 0;
      }
      const tightTotalMs = this.tightInflateMsWindow + this.tightExpandMsWindow + this.tightJpegMsWindow;
      if (tightTotalMs > 0) {
        this.lastTightWorkerBreakdown = `exp ${this.tightExpandMsWindow.toFixed(1)} infl ${this.tightInflateMsWindow.toFixed(1)} jpg ${this.tightJpegMsWindow.toFixed(1)}`;
      } else {
        this.lastTightWorkerBreakdown = "-";
      }
      this.frameMsWindow = 0;
      this.workerDecodeMsWindow = 0;
      this.blitMsWindow = 0;
      this.frameSamplesWindow = 0;
      this.tightInflateMsWindow = 0;
      this.tightExpandMsWindow = 0;
      this.tightJpegMsWindow = 0;
      this.emitStats(receivedRate);
    }, 1000);
  }

  private stopStatsTimer(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.receivedBytesWindow = 0;
    this.lastReceivedRate = 0;
    this.updatesWindow = 0;
    this.frameMsWindow = 0;
    this.workerDecodeMsWindow = 0;
    this.blitMsWindow = 0;
    this.frameSamplesWindow = 0;
    this.tightInflateMsWindow = 0;
    this.tightExpandMsWindow = 0;
    this.tightJpegMsWindow = 0;
    this.lastUpdatesPerSecond = 0;
    this.lastAvgFrameMs = 0;
    this.lastAvgWorkerDecodeMs = 0;
    this.lastAvgBlitMs = 0;
    this.lastTightWorkerBreakdown = "-";
  }

  private emitStats(receivedRate: number = this.lastReceivedRate): void {
    const workerQueueDepth = this.workerPending.size;
    const updateIntervalMs = this.lastUpdatesPerSecond > 0 ? 1000 / this.lastUpdatesPerSecond : Infinity;
    let bottleneckHint: "server-limited" | "client-limited" | "balanced" = "balanced";
    if (this.lastUpdatesPerSecond < 8 && this.lastAvgFrameMs < 10 && workerQueueDepth <= 1) {
      bottleneckHint = "server-limited";
    } else if ((this.lastAvgFrameMs > updateIntervalMs * 0.8 && this.lastUpdatesPerSecond > 0) || workerQueueDepth > 2) {
      bottleneckHint = "client-limited";
    }

    this.opts.onStats?.({
      encoding: this.currentEncoding,
      colorDepth: "24-bit RGBX",
      receivedRate,
      updatesPerSecond: this.lastUpdatesPerSecond,
      latencyMs: this.frameRTT,
      avgFrameMs: this.lastAvgFrameMs,
      avgWorkerDecodeMs: this.lastAvgWorkerDecodeMs,
      avgBlitMs: this.lastAvgBlitMs,
      tightWorkerBreakdown: this.lastTightWorkerBreakdown,
      workerQueueDepth,
      bottleneckHint,
    });
  }
}

function encodingName(enc: number): string {
  switch (enc) {
    case ENC_RAW:
      return "Raw";
    case ENC_COPYRECT:
      return "CopyRect";
    case ENC_HEXTILE:
      return "Hextile";
    case ENC_ZRLE:
      return "ZRLE";
    case ENC_TIGHT:
      return "Tight";
    case ENC_H264:
      return "H.264";
    case ENC_DESKTOP_SIZE:
      return "DesktopSize";
    case ENC_EXTENDED_DESKTOP_SIZE:
      return "ExtDesktopSize";
    case ENC_CURSOR:
      return "Cursor";
    case ENC_QEMU_EXTENDED_KEY:
      return "QEMU ExtKey";
    default:
      return `Enc ${enc}`;
  }
}

function preferredEncodingsForMode(mode: RfbEncodingMode): number[] {
  switch (mode) {
    case "h264":
      return [ENC_H264];
    case "tight":
      return [ENC_TIGHT];
    case "zrle":
      return [ENC_ZRLE];
    case "hextile":
      return [ENC_HEXTILE];
    case "raw":
      return [];
    case "auto":
    default:
      return [ENC_HEXTILE];
  }
}
