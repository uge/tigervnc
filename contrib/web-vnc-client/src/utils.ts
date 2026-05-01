/** Concatenate multiple Uint8Arrays into one. */
export function concat(...arrays: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Read a big-endian uint16 from a Uint8Array at byte offset. */
export function readU16(buf: Uint8Array, off: number): number {
  return ((buf[off] ?? 0) << 8) | (buf[off + 1] ?? 0);
}

/** Read a big-endian uint32 from a Uint8Array at byte offset. */
export function readU32(buf: Uint8Array, off: number): number {
  return (
    (((buf[off] ?? 0) << 24) |
      ((buf[off + 1] ?? 0) << 16) |
      ((buf[off + 2] ?? 0) << 8) |
      (buf[off + 3] ?? 0)) >>>
    0
  );
}

/** Read a big-endian signed int32 from a Uint8Array at byte offset. */
export function readS32(buf: Uint8Array, off: number): number {
  return (
    ((buf[off] ?? 0) << 24) |
    ((buf[off + 1] ?? 0) << 16) |
    ((buf[off + 2] ?? 0) << 8) |
    (buf[off + 3] ?? 0)
  );
}

/** Fill a region in an RGBA framebuffer with a solid RGB colour. */
export function fillRect(
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
  for (let dy = 0; dy < h; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      const i = ((y + dy) * fbWidth + (x + dx)) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
}

/** Write one RGB pixel (3 bytes) into the RGBA framebuffer at (px, py). */
export function writePixel(
  pixels: Uint8Array,
  fbWidth: number,
  px: number,
  py: number,
  r: number,
  g: number,
  b: number
): void {
  const i = (py * fbWidth + px) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = 255;
}
