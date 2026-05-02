import { applyHextile } from "../codecs/hextile";
import { ZrleDecoder } from "../codecs/zrle";
import { TightDecoder, type TightProfileSample } from "../codecs/tight";

// Report any errors that occur during module initialization
if (typeof globalThis !== 'undefined') {
  const origError = (globalThis as any).console?.error;
  const postWorkerError = (msg: string) => {
    try {
      (self as unknown as Worker).postMessage({ type: "init-error", message: msg });
    } catch (e) {
      // Ignore if postMessage fails
    }
  };
  if (origError) {
    (globalThis as any).console.error = (...args: any[]) => {
      origError(...args);
      postWorkerError(String(args[0]));
    };
  }
}

const ENC_RAW = 0;
const ENC_HEXTILE = 5;
const ENC_ZRLE = 16;
const ENC_TIGHT = 7;

interface DecodeRequest {
  id: number;
  enc: number;
  w: number;
  h: number;
  payload: ArrayBuffer;
}

interface ResetStatefulRequest {
  type: "resetStateful";
}

interface DecodeResponse {
  id: number;
  ok: boolean;
  rgba?: ArrayBuffer;
  decodeMs?: number;
  tightProfile?: TightProfileSample;
  error?: string;
}

const zrle = new ZrleDecoder();
const tight = new TightDecoder();

function decodeRawToRgba(data: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const si = i * 4;
    out[si] = data[si] ?? 0;
    out[si + 1] = data[si + 1] ?? 0;
    out[si + 2] = data[si + 2] ?? 0;
    out[si + 3] = 255;
  }
  return out;
}

function decodeRect(enc: number, w: number, h: number, payloadBuf: ArrayBuffer): Uint8Array | Promise<Uint8Array> {
  const payload = new Uint8Array(payloadBuf);

  if (enc === ENC_RAW) {
    return decodeRawToRgba(payload, w, h);
  }

  const patch = new Uint8Array(w * h * 4);

  if (enc === ENC_HEXTILE) {
    applyHextile(patch, w, 0, 0, w, h, payload);
    return patch;
  }

  if (enc === ENC_ZRLE) {
    zrle.applyRect(payload, patch, w, 0, 0, w, h);
    return patch;
  }

  if (enc === ENC_TIGHT) {
    const result = tight.applyRect(payload, patch, w, 0, 0, w, h);
    if (result instanceof Promise) {
      return result.then(() => patch);
    }
    return patch;
  }

  throw new Error(`Unsupported non-H264 worker encoding: ${enc}`);
}

function decodeTightRectWithProfile(w: number, h: number, payloadBuf: ArrayBuffer): Uint8Array | Promise<{ rgba: Uint8Array; tightProfile: TightProfileSample }> {
  const payload = new Uint8Array(payloadBuf);
  const patch = new Uint8Array(w * h * 4);
  const tightProfile: TightProfileSample = {
    subtype: "truecolor",
    inflateMs: 0,
    expandMs: 0,
    jpegMs: 0,
  };
  const result = tight.applyRect(payload, patch, w, 0, 0, w, h, tightProfile);
  if (result instanceof Promise) {
    return result.then(() => ({ rgba: patch, tightProfile }));
  }
  return { rgba: patch, tightProfile };
}

self.onmessage = async (ev: MessageEvent<DecodeRequest | ResetStatefulRequest>) => {
  const req = ev.data;

  if ((req as ResetStatefulRequest).type === "resetStateful") {
    zrle.reset();
    tight.reset();
    return;
  }

  const decodeReq = req as DecodeRequest;
  try {
    const decodeStart = performance.now();
    let rgba: Uint8Array;
    let tightProfile: TightProfileSample | undefined;
    if (decodeReq.enc === ENC_TIGHT) {
      const decoded = await decodeTightRectWithProfile(decodeReq.w, decodeReq.h, decodeReq.payload);
      if (decoded instanceof Uint8Array) {
        rgba = decoded;
      } else {
        rgba = decoded.rgba;
        tightProfile = decoded.tightProfile;
      }
    } else {
      rgba = await decodeRect(decodeReq.enc, decodeReq.w, decodeReq.h, decodeReq.payload);
    }
    const response: DecodeResponse = {
      id: decodeReq.id,
      ok: true,
      rgba: rgba.buffer,
      decodeMs: performance.now() - decodeStart,
      tightProfile,
    };
    (self as unknown as Worker).postMessage(response, [rgba.buffer]);
  } catch (error) {
    const response: DecodeResponse = {
      id: decodeReq.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
