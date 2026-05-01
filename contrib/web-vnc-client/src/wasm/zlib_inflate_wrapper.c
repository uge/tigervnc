#include <stdint.h>
#include <stdlib.h>
#include <zlib.h>

typedef struct wz_stream {
  z_stream zs;
  int initialized;
} wz_stream;

static wz_stream* cast_handle(uint32_t handle) {
  return (wz_stream*)(uintptr_t)handle;
}

uint32_t wz_create(void) {
  wz_stream* ctx = (wz_stream*)calloc(1, sizeof(wz_stream));
  if (ctx == NULL) {
    return 0;
  }

  int rc = inflateInit(&ctx->zs);
  if (rc != Z_OK) {
    free(ctx);
    return 0;
  }

  ctx->initialized = 1;
  return (uint32_t)(uintptr_t)ctx;
}

int wz_reset(uint32_t handle) {
  wz_stream* ctx = cast_handle(handle);
  if (ctx == NULL || !ctx->initialized) {
    return Z_STREAM_ERROR;
  }
  return inflateReset(&ctx->zs);
}

int wz_destroy(uint32_t handle) {
  wz_stream* ctx = cast_handle(handle);
  if (ctx == NULL) {
    return Z_STREAM_ERROR;
  }
  if (ctx->initialized) {
    inflateEnd(&ctx->zs);
  }
  free(ctx);
  return Z_OK;
}

int wz_inflate(
  uint32_t handle,
  uint32_t in_ptr,
  uint32_t in_len,
  uint32_t out_ptr,
  uint32_t out_cap,
  uint32_t out_len_ptr
) {
  wz_stream* ctx = cast_handle(handle);
  if (ctx == NULL || !ctx->initialized) {
    return Z_STREAM_ERROR;
  }

  uint8_t* out_written = (uint8_t*)(uintptr_t)out_len_ptr;
  if (out_written == NULL) {
    return Z_STREAM_ERROR;
  }

  ctx->zs.next_in = (Bytef*)(uintptr_t)in_ptr;
  ctx->zs.avail_in = in_len;
  ctx->zs.next_out = (Bytef*)(uintptr_t)out_ptr;
  ctx->zs.avail_out = out_cap;

  int rc = Z_OK;
  while (ctx->zs.avail_in > 0) {
    rc = inflate(&ctx->zs, Z_SYNC_FLUSH);

    if (rc == Z_STREAM_END) {
      inflateReset(&ctx->zs);
      rc = Z_OK;
      break;
    }

    if (rc == Z_BUF_ERROR) {
      // Propagate buffer errors to JS. Treating this as success can silently
      // truncate output and desynchronize stateful streams (ZRLE/Tight), which
      // later manifests as Z_DATA_ERROR (-3).
      break;
    }

    if (rc != Z_OK) {
      break;
    }

    if (ctx->zs.avail_out == 0) {
      break;
    }
  }

  uint32_t written = out_cap - ctx->zs.avail_out;
  ((uint32_t*)out_written)[0] = written;
  return rc;
}
