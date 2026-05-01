/**
 * Hextile encoding decoder – ported directly from vnc-decoder/src/hextileCodec.ts.
 *
 * Works with real VNC Hextile (encoding 5).  With the 32bpp RGBX pixel
 * format requested by this client, tile data uses 4 bytes per pixel/color.
 * The output is written into the caller's RGBA framebuffer.
 */
const HEXTILE_RAW               = 0x01;
const HEXTILE_BACKGROUND_SPECIFIED = 0x02;
const HEXTILE_FOREGROUND_SPECIFIED = 0x04;
const HEXTILE_ANY_SUBRECTS      = 0x08;
const HEXTILE_SUBRECTS_COLOURED = 0x10;

/**
 * Decode a Hextile-encoded rectangle and paint it into `pixels`.
 *
 * @param pixels  - RGBA framebuffer (width × height × 4 bytes)
 * @param fbWidth - full framebuffer width (pixels per row)
 * @param x / y   - top-left destination in the framebuffer
 * @param w / h   - rectangle dimensions
 * @param data    - raw Hextile payload bytes
 */
export function applyHextile(
  pixels: Uint8Array,
  fbWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  data: Uint8Array
): void {
  const fillRectFast = (
    dstX: number,
    dstY: number,
    rectW: number,
    rectH: number,
    r: number,
    g: number,
    b: number
  ): void => {
    for (let dy = 0; dy < rectH; dy += 1) {
      let di = ((dstY + dy) * fbWidth + dstX) * 4;
      for (let dx = 0; dx < rectW; dx += 1) {
        pixels[di] = r;
        pixels[di + 1] = g;
        pixels[di + 2] = b;
        pixels[di + 3] = 255;
        di += 4;
      }
    }
  };

  let offset = 0;
  let bgR = 0, bgG = 0, bgB = 0;
  let fgR = 255, fgG = 255, fgB = 255;

  for (let tileY = 0; tileY < h; tileY += 16) {
    for (let tileX = 0; tileX < w; tileX += 16) {
      const tileW = Math.min(16, w - tileX);
      const tileH = Math.min(16, h - tileY);
      const absX = x + tileX;
      const absY = y + tileY;

      if (offset >= data.length) throw new Error("truncated hextile payload");

      const subencoding = data[offset++]!;

      if ((subencoding & HEXTILE_RAW) !== 0) {
        const bytes = tileW * tileH * 4;
        if (offset + bytes > data.length) throw new Error("truncated hextile raw tile");
        let src = offset;
        for (let dy = 0; dy < tileH; dy += 1) {
          let di = ((absY + dy) * fbWidth + absX) * 4;
          for (let dx = 0; dx < tileW; dx += 1) {
            pixels[di] = data[src]!;
            pixels[di + 1] = data[src + 1]!;
            pixels[di + 2] = data[src + 2]!;
            pixels[di + 3] = 255;
            di += 4;
            src += 4;
          }
        }
        offset += bytes;
        continue;
      }

      if ((subencoding & HEXTILE_BACKGROUND_SPECIFIED) !== 0) {
        if (offset + 4 > data.length) throw new Error("truncated hextile background");
        bgR = data[offset++]!;
        bgG = data[offset++]!;
        bgB = data[offset++]!;
        offset += 1; // skip X/padding byte
      }

      fillRectFast(absX, absY, tileW, tileH, bgR, bgG, bgB);

      if ((subencoding & HEXTILE_FOREGROUND_SPECIFIED) !== 0) {
        if (offset + 4 > data.length) throw new Error("truncated hextile foreground");
        fgR = data[offset++]!;
        fgG = data[offset++]!;
        fgB = data[offset++]!;
        offset += 1; // skip X/padding byte
      }

      if ((subencoding & HEXTILE_ANY_SUBRECTS) === 0) continue;

      if (offset >= data.length) throw new Error("truncated hextile subrect count");
      const count = data[offset++]!;

      for (let i = 0; i < count; i += 1) {
        let sr = fgR, sg = fgG, sb = fgB;
        if ((subencoding & HEXTILE_SUBRECTS_COLOURED) !== 0) {
          if (offset + 4 > data.length) throw new Error("truncated hextile coloured subrect");
          sr = data[offset++]!;
          sg = data[offset++]!;
          sb = data[offset++]!;
          offset += 1; // skip X/padding byte
        }
        if (offset + 2 > data.length) throw new Error("truncated hextile subrect geometry");
        const xy = data[offset++]!;
        const wh = data[offset++]!;
        const sx = xy >> 4;
        const sy = xy & 0x0f;
        const sw = (wh >> 4) + 1;
        const sh = (wh & 0x0f) + 1;
        fillRectFast(absX + sx, absY + sy, sw, sh, sr, sg, sb);
      }
    }
  }
}
