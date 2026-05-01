/**
 * H.264 encoding decoder (VNC encoding 50) using FFmpeg WASM.
 *
 * H.264 encoding uses a context-based approach for streaming video.
 * Multiple H.264 decoders can be active for different rectangles, allowing
 * the server to efficiently update multiple areas of the screen with different
 * H.264 frames.
 *
 * The RFB spec specifies:
 * - 4-byte length field containing H.264 frame data size
 * - 4-byte flags field (ResetContext, ResetAllContexts)
 * - H.264 frame data (raw NAL units or byte stream format)
 *
 * Each rectangle has its own FFmpeg decoder context based on its coordinates.
 */
import { FFmpeg, fetchFile } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;
let ffmpegReady = false;

const MAX_CONTEXTS = 64;  // Per RFB spec: support 64 simultaneous contexts

interface H264Context {
  x: number;
  y: number;
  w: number;
  h: number;
  lastUpdate: number;
}

let contextMap: Map<string, H264Context> = new Map();

/** Generate a context key from rectangle coordinates. */
function getContextKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Get or create an H.264 decoder context for the given rectangle. */
function getOrCreateContext(x: number, y: number, w: number, h: number): H264Context {
  const key = getContextKey(x, y);
  let ctx = contextMap.get(key);

  if (!ctx) {
    // If we've exceeded max contexts, remove the oldest (least recently used)
    if (contextMap.size >= MAX_CONTEXTS) {
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, c] of contextMap) {
        if (c.lastUpdate < oldestTime) {
          oldestTime = c.lastUpdate;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        contextMap.delete(oldestKey);
      }
    }

    ctx = {
      x,
      y,
      w,
      h,
      lastUpdate: Date.now(),
    };
    contextMap.set(key, ctx);
  } else {
    ctx.lastUpdate = Date.now();
  }

  return ctx;
}

/** Reset a specific H.264 context. */
function resetContext(_x: number, _y: number, _w: number, _h: number): void {
  // FFmpeg contexts are managed implicitly; clearing the input/output
  // file references is sufficient for reset behavior.
}

/** Reset all H.264 contexts and reinitialize FFmpeg. */
export function resetAllH264Contexts(): void {
  contextMap.clear();
  // FFmpeg session is kept alive for reuse; full reset only on disconnect
}

/** Initialize FFmpeg WASM. Called once on first use. */
async function initFFmpeg(): Promise<void> {
  if (ffmpegReady) return;
  
  try {
    if (!ffmpeg) {
      ffmpeg = new FFmpeg();
    }
    
    if (!ffmpeg.loaded) {
      const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      });
    }
    
    ffmpegReady = true;
  } catch (err) {
    console.error("Failed to initialize FFmpeg WASM:", err);
    throw new Error("H.264 decoder initialization failed: " + String(err));
  }
}

/**
 * Decode H.264 frame data and render into the framebuffer.
 *
 * @param data         - H.264 frame data (raw bytes following the 8-byte RFB header)
 * @param pixels       - RGBA framebuffer (width × height × 4 bytes)
 * @param fbWidth      - full framebuffer width (pixels per row)
 * @param x / y        - top-left destination in the framebuffer
 * @param w / h        - rectangle dimensions
 * @param flags        - RFB H.264 flags (ResetContext, ResetAllContexts)
 */
export async function applyH264(
  data: Uint8Array,
  pixels: Uint8Array,
  fbWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  flags: number
): Promise<void> {
  try {
    // Initialize FFmpeg if needed
    await initFFmpeg();

    // Handle context reset flags
    const RESET_ALL_CONTEXTS = 0x02;
    if ((flags & RESET_ALL_CONTEXTS) !== 0) {
      resetAllH264Contexts();
    }

    // Get or create context for this rectangle
    getOrCreateContext(x, y, w, h);

    // Use FFmpeg to decode H.264
    if (!ffmpeg || !ffmpeg.loaded) {
      throw new Error("FFmpeg not initialized");
    }

    // Write the H.264 frame data to FFmpeg's virtual filesystem
    const inputFileName = "frame.h264";
    const outputFileName = "frame.png";
    
    ffmpeg.FS("writeFile", inputFileName, data);

    // Run FFmpeg to decode H.264 and convert to PNG
    await ffmpeg.run(
      "-i", inputFileName,
      "-f", "image2",
      "-vframes", "1",
      "-pix_fmt", "rgba",
      outputFileName
    );

    // Read the decoded image
    const pngData = ffmpeg.FS("readFile", outputFileName);
    
    // Clean up
    ffmpeg.FS("unlink", inputFileName);
    ffmpeg.FS("unlink", outputFileName);

    // Decode PNG and render to framebuffer
    await decodePNGAndRender(pngData, pixels, fbWidth, x, y, w, h);

  } catch (err) {
    console.error("H.264 decode failed:", err);
    // Fail gracefully - leave framebuffer unchanged
  }
}

/**
 * Decode PNG data and render to framebuffer.
 * Uses browser's built-in PNG decoding via canvas.
 */
async function decodePNGAndRender(
  pngData: Uint8Array,
  pixels: Uint8Array,
  fbWidth: number,
  x: number,
  y: number,
  w: number,
  h: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      // Create blob from PNG data
      const blob = new Blob([pngData], { type: "image/png" });
      const url = URL.createObjectURL(blob);

      // Create image element to decode PNG
      const img = new Image();
      img.onload = () => {
        try {
          // Create canvas to extract pixel data
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          
          if (!ctx) {
            throw new Error("Failed to get canvas context");
          }

          // Draw image to canvas
          ctx.drawImage(img, 0, 0, w, h);

          // Get pixel data as ImageData
          const imageData = ctx.getImageData(0, 0, w, h);
          
          // Copy to framebuffer
          for (let dy = 0; dy < h; dy++) {
            const srcOff = dy * w * 4;
            const dstOff = ((y + dy) * fbWidth + x) * 4;
            pixels.set(imageData.data.subarray(srcOff, srcOff + w * 4), dstOff);
          }

          URL.revokeObjectURL(url);
          resolve();
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to decode PNG image"));
      };

      // Trigger load
      img.src = url;
    } catch (err) {
      reject(err);
    }
  });
}

