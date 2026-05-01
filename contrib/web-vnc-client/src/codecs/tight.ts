/**
 * Tight encoding decoder (VNC encoding 7) using a custom WASM zlib backend
 * (when available) with fflate fallback, plus browser JPEG decode.
 * browser's createImageBitmap() for JPEG.
 *
 * Four persistent zlib streams are maintained (as required by the Tight spec).
 * For basic compression, the stream id is encoded in control-byte bits 5-4
 * (i.e. low 2 bits of the high nibble after shifting).
 *
 * Control byte layout:
 *   Bits 7-4: compression type (see TIGHT_* constants below)
 *   Bits 3-0: reset flags for zlib streams 3..0
 */
import { TightInflateStream } from "./tightInflateBackend";
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

function packRgba32(r: number, g: number, b: number): number {
  return LITTLE_ENDIAN
    ? (r | (g << 8) | (b << 16) | 0xff000000)
    : ((r << 24) | (g << 16) | (b << 8) | 0xff);
}

const TIGHT_FILL            = 0x08;
const TIGHT_JPEG            = 0x09;
const TIGHT_EXPLICIT_FILTER = 0x04;  // low nibble value = type with filter

const TIGHT_FILTER_COPY     = 0x00;
const TIGHT_FILTER_PALETTE  = 0x01;
const TIGHT_FILTER_GRADIENT = 0x02;

const TIGHT_MIN_TO_COMPRESS = 12;

export interface TightProfileSample {
  subtype: "fill" | "jpeg" | "palette" | "gradient" | "truecolor";
  inflateMs: number;
  expandMs: number;
  jpegMs: number;
}

/** Decode a compact (1–3 byte) Tight length field. Returns [value, nextOffset]. */
function readCompactLen(data: Uint8Array, offset: number): [number, number] {
  let byte0 = data[offset++]!;
  let len = byte0 & 0x7f;
  if ((byte0 & 0x80) !== 0) {
    const byte1 = data[offset++]!;
    len |= (byte1 & 0x7f) << 7;
    if ((byte1 & 0x80) !== 0) {
      len |= data[offset++]! << 14;
    }
  }
  return [len, offset];
}

/** Manages all four Tight zlib streams for a session. */
export class TightDecoder {
  private streams = [
    new TightInflateStream(),
    new TightInflateStream(),
    new TightInflateStream(),
    new TightInflateStream(),
  ];

  /** Reset all four inflate streams (call when switching to this encoding). */
  reset(): void {
    for (const s of this.streams) s.reset();
  }

  /**
   * Decode one Tight rectangle.  May return a Promise when JPEG sub-type is used
   * (requires async browser JPEG decoding via createImageBitmap).
   */
  applyRect(
    data: Uint8Array,
    pixels: Uint8Array,
    fbWidth: number,
    x: number,
    y: number,
    w: number,
    h: number,
    profile?: TightProfileSample
  ): void | Promise<void> {
    let offset = 0;
    const ctrl = data[offset++]!;
    const tightType = (ctrl >> 4) & 0x0f;

    // Reset requested streams (bits 3-0 of ctrl)
    for (let s = 0; s < 4; s += 1) {
      if ((ctrl >> s) & 1) {
        this.streams[s]!.reset();
      }
    }

    if (tightType === TIGHT_FILL) {
      if (profile) {
        profile.subtype = "fill";
        profile.inflateMs = 0;
        profile.expandMs = 0;
        profile.jpegMs = 0;
      }
      applyFill(pixels, fbWidth, x, y, w, h, data[offset]!, data[offset + 1]!, data[offset + 2]!);
      return;
    }

    if (tightType === TIGHT_JPEG) {
      const [len, next] = readCompactLen(data, offset);
      const jpegData = data.subarray(next, next + len);
      return this.applyJpeg(jpegData, pixels, fbWidth, x, y, w, h, profile);
    }

    // Basic / palette / gradient
    // Lower 2 bits of the Tight type select zlib stream 0..3.
    let streamId = tightType & 0x03;
    let paletteSize = 0;
    let paletteBuf: Uint8Array | undefined;
    let useGradient = false;

    if ((tightType & TIGHT_EXPLICIT_FILTER) !== 0) {
      const filterId = data[offset++]!;
      if (filterId === TIGHT_FILTER_COPY) {
      } else if (filterId === TIGHT_FILTER_PALETTE) {
        paletteSize = data[offset++]! + 1;
        paletteBuf = data.subarray(offset, offset + paletteSize * 3);
        offset += paletteSize * 3;
      } else if (filterId === TIGHT_FILTER_GRADIENT) {
        useGradient = true;
      }
    }

    const rowSize = paletteSize > 0
      ? (paletteSize <= 2 ? Math.floor((w + 7) / 8) : w)
      : w * 3;
    const dataSize = h * rowSize;
    let source: Uint8Array;

    if (dataSize >= TIGHT_MIN_TO_COMPRESS) {
      const inflateStart = profile ? performance.now() : 0;
      const [len, next] = readCompactLen(data, offset);
      const compressed = data.subarray(next, next + len);
      source = this.streams[streamId]!.decompress(compressed, dataSize);
      if (profile) profile.inflateMs = performance.now() - inflateStart;
    } else {
      source = data.subarray(offset, offset + dataSize);
      if (profile) profile.inflateMs = 0;
    }

    if (profile) {
      profile.subtype = paletteSize > 0 && paletteBuf
        ? "palette"
        : useGradient
          ? "gradient"
          : "truecolor";
      profile.jpegMs = 0;
    }
    const expandStart = profile ? performance.now() : 0;
    if (paletteSize > 0 && paletteBuf) {
      applyPalette(pixels, fbWidth, x, y, w, h, source, paletteBuf, paletteSize);
    } else if (useGradient) {
      applyGradient(pixels, fbWidth, x, y, w, h, source);
    } else {
      applyTruecolor(pixels, fbWidth, x, y, w, h, source);
    }
    if (profile) profile.expandMs = performance.now() - expandStart;
  }

  private async applyJpeg(
    jpegData: Uint8Array,
    pixels: Uint8Array,
    fbWidth: number,
    x: number,
    y: number,
    w: number,
    h: number,
    profile?: TightProfileSample
  ): Promise<void> {
    const jpegStart = profile ? performance.now() : 0;
    if (profile) {
      profile.subtype = "jpeg";
      profile.inflateMs = 0;
      profile.expandMs = 0;
    }
    // Fast path: ImageDecoder decodes JPEG directly to a CPU-accessible VideoFrame,
    // avoiding the canvas GPU upload → getImageData GPU readback roundtrip.
    if (typeof ImageDecoder !== "undefined") {
      const decoder = new ImageDecoder({
        data: jpegData.buffer.slice(jpegData.byteOffset, jpegData.byteOffset + jpegData.byteLength),
        type: "image/jpeg",
      });
      const { image } = await decoder.decode();
      const rgba = new Uint8Array(w * h * 4);
      await image.copyTo(rgba, { format: "RGBA" });
      image.close();
      decoder.close();
      for (let dy = 0; dy < h; dy += 1) {
        const srcOff = dy * w * 4;
        const dstOff = ((y + dy) * fbWidth + x) * 4;
        pixels.set(rgba.subarray(srcOff, srcOff + w * 4), dstOff);
      }
      if (profile) profile.jpegMs = performance.now() - jpegStart;
      return;
    }

    // Fallback: createImageBitmap → OffscreenCanvas.
    // willReadFrequently keeps the canvas surface in CPU memory so getImageData
    // does not have to stall on a GPU readback.
    const blob = new Blob([jpegData], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const src = ctx.getImageData(0, 0, w, h).data;
    for (let dy = 0; dy < h; dy += 1) {
      const srcOff = dy * w * 4;
      const dstOff = ((y + dy) * fbWidth + x) * 4;
      pixels.set(src.subarray(srcOff, srcOff + w * 4), dstOff);
    }
    if (profile) profile.jpegMs = performance.now() - jpegStart;
  }
}

// ── Sub-type renderers ────────────────────────────────────────────────────────

function applyFill(
  pixels: Uint8Array,
  fbWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number
): void {
  if (LITTLE_ENDIAN && (pixels.byteOffset & 3) === 0) {
    const pixels32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2);
    const packed = packRgba32(r, g, b);
    for (let dy = 0; dy < h; dy += 1) {
      const rowStart = (y + dy) * fbWidth + x;
      pixels32.fill(packed, rowStart, rowStart + w);
    }
    return;
  }

  for (let dy = 0; dy < h; dy += 1) {
    let di = ((y + dy) * fbWidth + x) * 4;
    for (let dx = 0; dx < w; dx += 1) {
      pixels[di] = r;
      pixels[di + 1] = g;
      pixels[di + 2] = b;
      pixels[di + 3] = 255;
      di += 4;
    }
  }
}

function applyTruecolor(
  pixels: Uint8Array, fbWidth: number,
  x: number, y: number, w: number, h: number,
  source: Uint8Array
): void {
  if (LITTLE_ENDIAN && (pixels.byteOffset & 3) === 0) {
    const pixels32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2);
    let s = 0;
    for (let dy = 0; dy < h; dy += 1) {
      let di = (y + dy) * fbWidth + x;
      for (let dx = 0; dx < w; dx += 1) {
        pixels32[di++] = packRgba32(source[s]!, source[s + 1]!, source[s + 2]!);
        s += 3;
      }
    }
    return;
  }

  let s = 0;
  for (let dy = 0; dy < h; dy += 1) {
    let di = ((y + dy) * fbWidth + x) * 4;
    for (let dx = 0; dx < w; dx += 1) {
      pixels[di    ] = source[s    ]!;
      pixels[di + 1] = source[s + 1]!;
      pixels[di + 2] = source[s + 2]!;
      pixels[di + 3] = 255;
      di += 4;
      s  += 3;
    }
  }
}

function applyPalette(
  pixels: Uint8Array, fbWidth: number,
  x: number, y: number, w: number, h: number,
  source: Uint8Array, paletteBuf: Uint8Array, paletteSize: number
): void {
  const palette = new Uint32Array(paletteSize);
  for (let i = 0; i < paletteSize; i += 1) {
    palette[i] = packRgba32(paletteBuf[i * 3]!, paletteBuf[i * 3 + 1]!, paletteBuf[i * 3 + 2]!);
  }

  if (LITTLE_ENDIAN && (pixels.byteOffset & 3) === 0) {
    const pixels32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2);
    let s = 0;
    for (let dy = 0; dy < h; dy += 1) {
      let di = (y + dy) * fbWidth + x;
      if (paletteSize <= 2) {
        let bitsLeft = 0;
        let packed = 0;
        for (let dx = 0; dx < w; dx += 1) {
          if (bitsLeft === 0) { packed = source[s++]!; bitsLeft = 8; }
          bitsLeft -= 1;
          pixels32[di++] = palette[(packed >> bitsLeft) & 1] ?? packRgba32(0, 0, 0);
        }
      } else {
        for (let dx = 0; dx < w; dx += 1) {
          pixels32[di++] = palette[source[s++]!] ?? packRgba32(0, 0, 0);
        }
      }
    }
    return;
  }

  let s = 0;
  for (let dy = 0; dy < h; dy += 1) {
    let di = ((y + dy) * fbWidth + x) * 4;
    if (paletteSize <= 2) {
      let bitsLeft = 0;
      let packed = 0;
      for (let dx = 0; dx < w; dx += 1) {
        if (bitsLeft === 0) { packed = source[s++]!; bitsLeft = 8; }
        bitsLeft -= 1;
        const idx = (packed >> bitsLeft) & 1;
        const pi = idx * 3;
        pixels[di    ] = paletteBuf[pi] ?? 0;
        pixels[di + 1] = paletteBuf[pi + 1] ?? 0;
        pixels[di + 2] = paletteBuf[pi + 2] ?? 0;
        pixels[di + 3] = 255;
        di += 4;
      }
    } else {
      for (let dx = 0; dx < w; dx += 1) {
        const idx = source[s++]!;
        const pi = idx * 3;
        pixels[di    ] = paletteBuf[pi] ?? 0;
        pixels[di + 1] = paletteBuf[pi + 1] ?? 0;
        pixels[di + 2] = paletteBuf[pi + 2] ?? 0;
        pixels[di + 3] = 255;
        di += 4;
      }
    }
  }
}

function clamp(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : v; }

function applyGradient(
  pixels: Uint8Array, fbWidth: number,
  x: number, y: number, w: number, h: number,
  source: Uint8Array
): void {
  const prevRow = new Uint8Array(w * 3);
  let p0 = 0, p1 = 0, p2 = 0;  // current pixel channels

  if (LITTLE_ENDIAN && (pixels.byteOffset & 3) === 0) {
    const pixels32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2);
    for (let dy = 0; dy < h; dy += 1) {
      let di = (y + dy) * fbWidth + x;
      let s = (dy * w) * 3;
      for (let dx = 0; dx < w; dx += 1) {
        if (dx === 0) {
          p0 = (source[s]     + prevRow[0]) & 0xff;
          p1 = (source[s + 1] + prevRow[1]) & 0xff;
          p2 = (source[s + 2] + prevRow[2]) & 0xff;
        } else {
          const pi = dx * 3;
          p0 = (source[s]     + clamp(prevRow[pi]     + p0 - prevRow[pi - 3])) & 0xff;
          p1 = (source[s + 1] + clamp(prevRow[pi + 1] + p1 - prevRow[pi - 2])) & 0xff;
          p2 = (source[s + 2] + clamp(prevRow[pi + 2] + p2 - prevRow[pi - 1])) & 0xff;
        }
        pixels32[di++] = packRgba32(p0, p1, p2);
        const pi = dx * 3;
        prevRow[pi] = p0;
        prevRow[pi + 1] = p1;
        prevRow[pi + 2] = p2;
        s += 3;
      }
    }
    return;
  }

  for (let dy = 0; dy < h; dy += 1) {
    let di = ((y + dy) * fbWidth + x) * 4;
    let s = (dy * w) * 3;
    for (let dx = 0; dx < w; dx += 1) {
      if (dx === 0) {
        p0 = (source[s    ]! + prevRow[0]!) & 0xff;
        p1 = (source[s + 1]! + prevRow[1]!) & 0xff;
        p2 = (source[s + 2]! + prevRow[2]!) & 0xff;
      } else {
        const pi = dx * 3;
        p0 = (source[s    ]! + clamp(prevRow[pi    ]! + p0 - prevRow[pi - 3]!)) & 0xff;
        p1 = (source[s + 1]! + clamp(prevRow[pi + 1]! + p1 - prevRow[pi - 2]!)) & 0xff;
        p2 = (source[s + 2]! + clamp(prevRow[pi + 2]! + p2 - prevRow[pi - 1]!)) & 0xff;
      }
      pixels[di    ] = p0;
      pixels[di + 1] = p1;
      pixels[di + 2] = p2;
      pixels[di + 3] = 255;
      const pi = dx * 3;
      prevRow[pi    ] = p0;
      prevRow[pi + 1] = p1;
      prevRow[pi + 2] = p2;
      di += 4;
      s  += 3;
    }
  }
}
