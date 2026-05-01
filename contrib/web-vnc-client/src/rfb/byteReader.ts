import { concat } from "../utils";

type Resolver = { n: number; resolve: (data: Uint8Array) => void };

/**
 * Accumulates WebSocket binary frames and delivers exact-length slices via
 * the async `read(n)` method.  Multiple callers can await concurrently; they
 * are served strictly FIFO.
 */
export class ByteReader {
  // Explicit annotation avoids TypeScript 5.x Uint8Array<ArrayBufferLike> inference
  private buf: Uint8Array = new Uint8Array(0);
  private waiters: Resolver[] = [];

  /** Push a new chunk received from the WebSocket. */
  push(data: ArrayBuffer | Uint8Array): void {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.buf = concat(this.buf, chunk);
    this.flush();
  }

  /** Wait until exactly `n` bytes are available, then return them. */
  read(n: number): Promise<Uint8Array> {
    if (this.buf.length >= n) {
      const out = this.buf.slice(0, n);
      this.buf = this.buf.subarray(n);
      return Promise.resolve(out);
    }
    return new Promise((resolve) => {
      this.waiters.push({ n, resolve });
    });
  }

  private flush(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters[0]!;
      if (this.buf.length < w.n) break;
      this.waiters.shift();
      const out = this.buf.slice(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(out);
    }
  }
}
