# H.264 Protocol Support

This document describes the H.264 encoding implementation for the Web VNC Client.

## Overview

H.264 encoding (RFB encoding 50) is a video compression format that can significantly reduce bandwidth requirements for VNC streams, especially for high-resolution or high-frequency updates. The implementation uses FFmpeg WASM for hardware-accelerated decoding when available.

## Architecture

### Decoder Implementation (`src/codecs/h264.ts`)

The H.264 decoder is implemented using FFmpeg WASM with the following features:

- **Context Management**: Supports up to 64 simultaneous H.264 decoder contexts (per RFB spec), one per rectangle. Contexts are LRU-evicted when the limit is exceeded.
- **Lazy Initialization**: FFmpeg WASM is lazily loaded on first H.264 frame to avoid overhead for clients that don't use H.264.
- **Frame Decoding**: H.264 frame data is decoded via FFmpeg and converted to PNG, then rendered to the framebuffer.
- **Context Reset**: Supports RFB context reset flags for synchronization and error recovery.

### Protocol Integration

**File**: `src/rfb/client.ts`

Integration points:
- **Encoding Constant**: `ENC_H264 = 50` (matches RFB spec)
- **Message Parsing**: Reads 4-byte length + 4-byte flags + H.264 frame data
- **Frame Processing**: Calls `applyH264()` for each H.264-encoded rectangle
- **Mode Support**: Added to `RfbEncodingMode` type and encoding selection UI

### UI Changes

**File**: `index.html`

Added "H.264" option to the encoding selector dropdown, allowing users to test H.264 decoding alongside other encodings (Tight, ZRLE, Hextile, Raw).

## Dependencies

- `@ffmpeg/ffmpeg` (^0.12.10): Main FFmpeg WASM library
- `@ffmpeg/util` (^0.12.1): Utility functions for FFmpeg WASM

FFmpeg WASM files are loaded from CDN (jsDelivr) to avoid bundling the ~30MB core library.

## Usage

### Enabling H.264 in the UI

1. Open the Web VNC Client
2. Select "H.264" from the encoding dropdown
3. Connect to a VNC server that supports H.264 encoding
4. The client will automatically decode and render H.264 frames

### Programmatic Usage

```typescript
import { RfbClient } from "./rfb/client";

const client = new RfbClient({
  url: "ws://localhost:5900",
  encodingMode: "h264",  // Request H.264 encoding
  onFrame: (imageData) => {
    // Process decoded frame
  }
});
```

## Performance Considerations

### Advantages
- Significantly reduced bandwidth (10-20% of uncompressed pixel size)
- Good for high-resolution displays
- Hardware acceleration where available

### Tradeoffs
- FFmpeg WASM adds ~30MB to initial load (loaded on-demand from CDN)
- Decoding latency: FFmpeg → PNG → Canvas rendering pipeline
- Per-context memory overhead

### Optimization Opportunities
- Direct H.264 decoding (bypassing PNG intermediate format)
- GPU rendering acceleration
- Streaming decode (frame fragments as NAL units arrive)

## RFB Specification Compliance

### H.264 Message Format
```
4 bytes   : U32 length (size of H.264 frame data)
4 bytes   : U32 flags
           Bits 0-30: reserved
           Bit 31: ResetContext (reset this rect's decoder)
           Bit 30: ResetAllContexts (reset all decoders)
length bytes : H.264 frame data
```

### Context Management
- **Per-Rectangle Context**: Each rectangle at coordinates (x, y) has its own decoder
- **Max Contexts**: 64 simultaneously active contexts (LRU eviction)
- **Context Reset**: Optional ResetContext/ResetAllContexts flags for sync points
- **Stateful Decoding**: H.264 decoders maintain state across frames for efficient differential coding

## Testing

### Basic Test
```bash
# Start dev server
npm run dev

# Test with H.264-capable VNC server
# Connect to server, select "H.264" encoding, observe frame decoding
```

### Known Limitations
- Requires FFmpeg WASM support (modern browsers only)
- H.264 frame data must be well-formed (malformed frames may cause decode errors)
- Large frame dimensions may impact decoding latency

## Future Enhancements

1. **Direct H.264 Decoding**: Replace PNG intermediate with direct frame buffer output
2. **HEVC/VP9 Support**: Extend to other modern codecs
3. **GPU Rendering**: Use WebGL/Canvas optimization for faster rendering
4. **Streaming Decode**: Process frame fragments (NAL units) as they arrive
5. **Performance Metrics**: Decode latency, bandwidth savings tracking
