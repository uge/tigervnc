import { Decompress } from "fflate";

const wasmUrl = (globalThis as { __TIGHT_ZLIB_WASM_URL__?: string }).__TIGHT_ZLIB_WASM_URL__
  ?? "/zlib-inflate.wasm";

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  _malloc?: (size: number) => number;
  malloc?: (size: number) => number;
  _free?: (ptr: number) => void;
  free?: (ptr: number) => void;
  _wz_create?: () => number;
  wz_create?: () => number;
  _wz_reset?: (handle: number) => number;
  wz_reset?: (handle: number) => number;
  _wz_destroy?: (handle: number) => number;
  wz_destroy?: (handle: number) => number;
  _wz_inflate?: (
    handle: number,
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
    outLenPtr: number
  ) => number;
  wz_inflate?: (
    handle: number,
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
    outLenPtr: number
  ) => number;
}

interface WasmRuntime {
  memory: WebAssembly.Memory;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  wzCreate: () => number;
  wzReset: (handle: number) => number;
  wzDestroy: (handle: number) => number;
  wzInflate: (
    handle: number,
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
    outLenPtr: number
  ) => number;
}

class FflateInflateStream {
  private inf: Decompress;
  private out = new Uint8Array(0);
  private outUsed = 0;

  constructor() {
    this.inf = new Decompress();
    this.inf.ondata = (chunk: Uint8Array) => this.appendChunk(chunk);
  }

  reset(): void {
    this.inf = new Decompress();
    this.inf.ondata = (chunk: Uint8Array) => this.appendChunk(chunk);
  }

  decompress(data: Uint8Array, expectedSize: number): Uint8Array {
    if (this.out.length < expectedSize) {
      this.out = new Uint8Array(expectedSize);
    }
    this.outUsed = 0;
    this.inf.push(data);
    return this.out.subarray(0, this.outUsed);
  }

  private appendChunk(chunk: Uint8Array): void {
    const nextUsed = this.outUsed + chunk.length;
    if (nextUsed > this.out.length) {
      const grown = new Uint8Array(Math.max(nextUsed, this.out.length << 1, 1024));
      grown.set(this.out.subarray(0, this.outUsed));
      this.out = grown;
    }
    this.out.set(chunk, this.outUsed);
    this.outUsed = nextUsed;
  }
}

class WasmInflateStream {
  private readonly handle: number;

  constructor(private readonly runtime: WasmRuntime) {
    this.handle = runtime.wzCreate();
    if (!this.handle) {
      throw new Error("wz_create failed");
    }
  }

  reset(): void {
    const rc = this.runtime.wzReset(this.handle);
    if (rc !== 0) {
      throw new Error(`wz_reset failed with code ${rc}`);
    }
  }

  decompress(data: Uint8Array, expectedSize: number): Uint8Array {
    const inPtr = this.runtime.malloc(data.byteLength);
    const outPtr = this.runtime.malloc(expectedSize);
    const outLenPtr = this.runtime.malloc(4);
    if (!inPtr || !outPtr || !outLenPtr) {
      if (inPtr) this.runtime.free(inPtr);
      if (outPtr) this.runtime.free(outPtr);
      if (outLenPtr) this.runtime.free(outLenPtr);
      throw new Error("malloc failed in wasm inflate backend");
    }

    try {
      new Uint8Array(this.runtime.memory.buffer, inPtr, data.byteLength).set(data);
      new Uint32Array(this.runtime.memory.buffer, outLenPtr, 1)[0] = 0;

      const rc = this.runtime.wzInflate(
        this.handle,
        inPtr,
        data.byteLength,
        outPtr,
        expectedSize,
        outLenPtr
      );

      if (rc !== 0) {
        throw new Error(`wz_inflate failed with code ${rc}`);
      }

      const produced = new Uint32Array(this.runtime.memory.buffer, outLenPtr, 1)[0] ?? 0;
      const view = new Uint8Array(this.runtime.memory.buffer, outPtr, produced);
      const out = new Uint8Array(produced);
      out.set(view);
      return out;
    } finally {
      this.runtime.free(inPtr);
      this.runtime.free(outPtr);
      this.runtime.free(outLenPtr);
    }
  }

  dispose(): void {
    this.runtime.wzDestroy(this.handle);
  }
}

let runtimeInitStarted = false;
let runtimeReady: WasmRuntime | null = null;
let runtimePromise: Promise<boolean> | null = null;

function getFn<T extends Function>(a?: T, b?: T): T | null {
  if (a) return a;
  if (b) return b;
  return null;
}

async function buildRuntime(): Promise<void> {
  try {
    const imports = {
      env: {
        abort: () => {
          throw new Error("wasm zlib abort");
        },
      },
      wasi_snapshot_preview1: {
        proc_exit: () => {
          throw new Error("wasm zlib proc_exit");
        },
        fd_write: () => 0,
        fd_close: () => 0,
        fd_seek: () => 0,
      },
    };

    const response = await fetch(wasmUrl);
    let instance: WebAssembly.Instance;
    try {
      const instantiated = await WebAssembly.instantiateStreaming(response, imports);
      instance = instantiated.instance;
    } catch {
      const bytes = await response.arrayBuffer();
      const instantiated = await WebAssembly.instantiate(bytes, imports);
      instance = instantiated.instance;
    }

    const exports = instance.exports as WasmExports;
    const memory = exports.memory;
    const malloc = getFn(exports._malloc, exports.malloc);
    const free = getFn(exports._free, exports.free);
    const wzCreate = getFn(exports._wz_create, exports.wz_create);
    const wzReset = getFn(exports._wz_reset, exports.wz_reset);
    const wzDestroy = getFn(exports._wz_destroy, exports.wz_destroy);
    const wzInflate = getFn(exports._wz_inflate, exports.wz_inflate);

    if (!memory || !malloc || !free || !wzCreate || !wzReset || !wzDestroy || !wzInflate) {
      runtimeReady = null;
      return;
    }

    runtimeReady = {
      memory,
      malloc: (size) => malloc(size) as number,
      free: (ptr) => free(ptr) as void,
      wzCreate: () => wzCreate() as number,
      wzReset: (handle) => wzReset(handle) as number,
      wzDestroy: (handle) => wzDestroy(handle) as number,
      wzInflate: (handle, inPtr, inLen, outPtr, outCap, outLenPtr) =>
        wzInflate(handle, inPtr, inLen, outPtr, outCap, outLenPtr) as number,
    };
  } catch {
    runtimeReady = null;
  }
}

function startRuntimeInit(): Promise<boolean> {
  if (runtimePromise) return runtimePromise;
  runtimeInitStarted = true;
  runtimePromise = buildRuntime().then(() => runtimeReady !== null);
  return runtimePromise;
}

/**
 * Resolves to true if the wasm backend loaded successfully, false if
 * the app will fall back to fflate. Call this before opening a VNC
 * session to guarantee the faster wasm path is used from frame 1.
 */
export function warmUpWasm(): Promise<boolean> {
  return startRuntimeInit();
}

export function getInflateBackendStatus(): "wasm" | "fflate" | null {
  if (!runtimeInitStarted) return null;
  return runtimeReady ? "wasm" : "fflate";
}

startRuntimeInit();

export class TightInflateStream {
  private fflate: FflateInflateStream | null = null;
  private wasm: WasmInflateStream | null = null;

  constructor(private readonly preferFflate = true) {}

  reset(): void {
    if (this.preferFflate) {
      if (!this.fflate) {
        this.fflate = new FflateInflateStream();
        return;
      }
      this.fflate.reset();
      return;
    }

    if (runtimeReady && !this.wasm) {
      this.fflate = null;
      this.wasm = new WasmInflateStream(runtimeReady);
    }

    if (this.wasm) {
      this.wasm.reset();
      return;
    }

    if (!this.fflate) {
      this.fflate = new FflateInflateStream();
      return;
    }

    this.fflate.reset();
  }

  decompress(data: Uint8Array, expectedSize: number): Uint8Array {
    if (this.preferFflate) {
      if (!this.fflate) {
        this.fflate = new FflateInflateStream();
      }
      return this.fflate.decompress(data, expectedSize);
    }

    // Backend is selected once — either in reset() or on first use here.
    // We NEVER switch mid-stream: doing so would silently discard the live
    // zlib window state and corrupt stateful streams like ZRLE.
    if (!this.wasm && !this.fflate) {
      if (runtimeReady) {
        this.wasm = new WasmInflateStream(runtimeReady);
      } else {
        this.fflate = new FflateInflateStream();
      }
    }

    if (this.wasm) {
      return this.wasm.decompress(data, expectedSize);
    }

    return this.fflate!.decompress(data, expectedSize);
  }
}
