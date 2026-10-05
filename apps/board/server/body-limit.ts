import type { Context, MiddlewareHandler } from "hono";

/**
 * Caps request bodies without re-creating the Request.
 *
 * hono/body-limit counts chunked bodies (no Content-Length, as sent through
 * Cloudflare) and then wraps the request in `new Request(c.req.raw, …)`. Under
 * the Vike/Node server `c.req.raw` is not a native Request, so that throws
 * ("Cannot read private member #state") and every such POST became a 500.
 *
 * Here the body is read once, counting bytes, and stored in Hono's own body
 * cache, so later `c.req.text()` / `json()` / `parseBody()` reuse it.
 */
export function cappedBody(options: {
  maxSize: number;
  onError: (c: Context) => Response | Promise<Response>;
}): MiddlewareHandler {
  const { maxSize, onError } = options;
  return async (c, next) => {
    const raw = c.req.raw;
    if (raw.body === null) return next();
    const declared = raw.headers.get("content-length");
    const chunked = raw.headers.has("transfer-encoding");
    if (declared !== null && !chunked) {
      const length = Number.parseInt(declared, 10);
      if (Number.isFinite(length) && length > maxSize) return onError(c);
    }
    const reader = raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) {
        await reader.cancel().catch(() => undefined);
        return onError(c);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Hono stores promises in bodyCache at runtime (its types say the value).
    (c.req.bodyCache as Record<string, unknown>).arrayBuffer = Promise.resolve(body.buffer);
    return next();
  };
}
