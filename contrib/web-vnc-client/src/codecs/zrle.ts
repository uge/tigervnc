/**
 * ZRLE encoding decoder (VNC encoding 16).
 *
 * Real-VNC ZRLE spec calls for a persistent zlib stream, but in practice
 * sync flushes between rectangles may not be reliable across all encoders/backends.
 * To prevent stale data corruption on window moves, we use a fresh inflate
 * stream per rectangle. This sacrifices some efficiency but guarantees no
 * cross-rectangle contamination.
 *
 * Tile types supported:
 *   0   – Raw
 *   1   – Solid
 *   2–16 – Packed palette
 *   128 – Plain RLE
 *  130–255 – Palette RLE
 */
import { TightInflateStream } from "./tightInflateBackend";
import { fillRect, writePixel } from "../utils";

const TILE_SIZE = 64;

/** Manages the persistent zlib stream required by ZRLE. */
export class ZrleDecoder {
  // ZRLE uses a continuous zlib stream across rectangles. We keep a single
  // stream instance for the session and reset it only on protocol boundaries
  // such as resize/encoding changes/reconnect.
  private inflate = new TightInflateStream(true);

  /**
   * Reset the stream state at known protocol boundaries.
   */
  reset(): void {
    this.inflate.reset();
  }

  /**
   * Decompress one ZRLE block (from a single rectangle).
   *
   * @param data   - compressed bytes for this rectangle
   * @param maxOut - upper bound on decompressed size (w * h * 4 bytes)
   */
  private decompress(data: Uint8Array, maxOut: number): Uint8Array {
    return this.inflate.decompress(data, maxOut);
  }

  /**
   * Decode one ZRLE rectangle from compressed `data` and paint it into the
   * RGBA framebuffer `pixels`.
   */
  applyRect(
    compressedData: Uint8Array,
    pixels: Uint8Array,
    fbWidth: number,
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    const tilesX = Math.ceil(w / TILE_SIZE);
    const tilesY = Math.ceil(h / TILE_SIZE);
    // Worst case per tile: 1 type byte + TILE_SIZE² raw cpixels at 3 bytes.
    // Plain/palette-RLE overhead can exceed w*h*4 for tiny rects, so take
    // the larger of the two bounds.
    const maxOut = Math.max(w * h * 4, tilesX * tilesY * (1 + TILE_SIZE * TILE_SIZE * 3));
    const raw = this.decompress(compressedData, maxOut);
    let pos = 0;
    console.log(`[ZRLE] applyRect: pos(${x},${y}) size(${w}x${h}) compressed=${compressedData.length} decompressed=${raw.length} maxOut=${maxOut}`);

    try {
      for (let tr = 0; tr < tilesY; tr += 1) {
        for (let tc = 0; tc < tilesX; tc += 1) {
          const tileX = tc * TILE_SIZE;
          const tileY = tr * TILE_SIZE;
          const tileW = Math.min(TILE_SIZE, w - tileX);
          const tileH = Math.min(TILE_SIZE, h - tileY);
          const absX = x + tileX;
          const absY = y + tileY;
          const tilePixels = tileW * tileH;

          if (pos >= raw.length) throw new Error("zrle: unexpected end of tile stream");
          const type = raw[pos++]!;

          if (type === 0) {
            // Raw: tileW * tileH cpixels (3 bytes each)
            for (let ty = 0; ty < tileH; ty += 1) {
              for (let tx = 0; tx < tileW; tx += 1) {
                writePixel(pixels, fbWidth, absX + tx, absY + ty,
                  raw[pos]!, raw[pos + 1]!, raw[pos + 2]!);
                pos += 3;
              }
            }
          } else if (type === 1) {
            // Solid: one cpixel for whole tile
            fillRect(pixels, fbWidth, absX, absY, tileW, tileH,
              raw[pos]!, raw[pos + 1]!, raw[pos + 2]!);
            pos += 3;
          } else if (type >= 2 && type <= 16) {
            // Packed palette
            const paletteSize = type;
            const palette: Array<[number, number, number]> = [];
            for (let p = 0; p < paletteSize; p += 1) {
              palette.push([raw[pos]!, raw[pos + 1]!, raw[pos + 2]!]);
              pos += 3;
            }
            // Bits per index: 1 for palette 2, 2 for 3-4, 4 for 5-16
            const bitsPerIdx = paletteSize <= 2 ? 1 : paletteSize <= 4 ? 2 : 4;
            const mask = (1 << bitsPerIdx) - 1;

            for (let ty = 0; ty < tileH; ty += 1) {
              // Each row is packed independently and padded to a whole byte —
              // reset the bit accumulator at the start of every row.
              let bits = 0;
              let bitsLeft = 0;
              for (let tx = 0; tx < tileW; tx += 1) {
                if (bitsLeft < bitsPerIdx) {
                  bits = (bits << 8) | (raw[pos++]!);
                  bitsLeft += 8;
                }
                bitsLeft -= bitsPerIdx;
                const idx = (bits >> bitsLeft) & mask;
                const [r, g, b] = palette[idx] ?? [0, 0, 0];
                writePixel(pixels, fbWidth, absX + tx, absY + ty, r!, g!, b!);
              }
            }
          } else if (type === 128) {
            // Plain RLE
            let pixelsLeft = tilePixels;
            let dstIdx = 0;
            while (pixelsLeft > 0) {
              const r = raw[pos]!; const g = raw[pos + 1]!; const b = raw[pos + 2]!;
              pos += 3;
              let runLen = 1;
              let lenByte: number;
              do {
                lenByte = raw[pos++]!;
                runLen += lenByte;
              } while (lenByte === 255);

              for (let i = 0; i < runLen; i += 1, dstIdx += 1) {
                const tx = dstIdx % tileW;
                const ty = Math.floor(dstIdx / tileW);
                writePixel(pixels, fbWidth, absX + tx, absY + ty, r, g, b);
              }
              pixelsLeft -= runLen;
            }
          } else if (type >= 130) {
            // Palette RLE
            const paletteSize = type - 128;
            const palette: Array<[number, number, number]> = [];
            for (let p = 0; p < paletteSize; p += 1) {
              palette.push([raw[pos]!, raw[pos + 1]!, raw[pos + 2]!]);
              pos += 3;
            }
            let pixelsLeft = tilePixels;
            let dstIdx = 0;
            while (pixelsLeft > 0) {
              const indexByte = raw[pos++]!;
              const paletteIndex = indexByte & 0x7f;
              const [r, g, b] = palette[paletteIndex] ?? [0, 0, 0];
              let runLen = 1;
              if ((indexByte & 0x80) !== 0) {
                let lenByte: number;
                do {
                  lenByte = raw[pos++]!;
                  runLen += lenByte;
                } while (lenByte === 255);
              }
              for (let i = 0; i < runLen; i += 1, dstIdx += 1) {
                const tx = dstIdx % tileW;
                const ty = Math.floor(dstIdx / tileW);
                writePixel(pixels, fbWidth, absX + tx, absY + ty, r!, g!, b!);
              }
              pixelsLeft -= runLen;
            }
          } else {
            throw new Error(`zrle: unsupported tile type ${type}`);
          }
        }
      }
      // Validate that all decompressed data was consumed.
      if (pos !== raw.length) {
        console.warn(`[ZRLE] WARNING: decompressed ${raw.length} bytes but only consumed ${pos} (${raw.length - pos} left over)`);
      } else {
        console.log(`[ZRLE] OK: consumed all ${pos} decompressed bytes`);
      }
    } catch (err) {
      // With per-rectangle inflate streams, errors don't corrupt future rectangles.
      // We can safely let the error propagate to the caller.
      console.error(`[ZRLE] ERROR in applyRect at pos(${x},${y}):`, err);
      throw err;
    }
  }
}
