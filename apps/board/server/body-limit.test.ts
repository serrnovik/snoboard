import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { cappedBody } from "./body-limit.js";

function makeApp(maxSize: number) {
  const app = new Hono();
  app.use(cappedBody({ maxSize, onError: (c) => c.json({ error: "payload too large" }, 413) }));
  app.post("/text", async (c) => c.json({ text: await c.req.text() }));
  app.post("/json", async (c) => c.json({ json: await c.req.json() }));
  app.post("/form", async (c) => c.json({ form: await c.req.parseBody() }));
  return app;
}

/** A request with a streamed body and no Content-Length, like Cloudflare forwards. */
function chunkedRequest(path: string, parts: string[], contentType: string): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Request(`http://board.test${path}`, {
    method: "POST",
    headers: { "content-type": contentType, "transfer-encoding": "chunked" },
    body: stream,
    duplex: "half",
  } as RequestInit);
}

describe("cappedBody", () => {
  it("passes chunked JSON, text and form bodies through to handlers", async () => {
    const app = makeApp(1024);
    const json = await app.request(chunkedRequest("/json", ['{"a":', "1}"], "application/json"));
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ json: { a: 1 } });

    const text = await app.request(chunkedRequest("/text", ["hel", "lo"], "text/plain"));
    expect(await text.json()).toEqual({ text: "hello" });

    const form = await app.request(
      chunkedRequest("/form", ["password=", "s3cret"], "application/x-www-form-urlencoded"),
    );
    expect(await form.json()).toEqual({ form: { password: "s3cret" } });
  });

  it("rejects a chunked body over the limit while reading", async () => {
    const app = makeApp(8);
    const res = await app.request(chunkedRequest("/text", ["12345", "67890"], "text/plain"));
    expect(res.status).toBe(413);
  });

  it("rejects an oversized Content-Length up front and accepts one within the limit", async () => {
    const app = makeApp(8);
    const big = await app.request("/text", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "100" },
      body: "x".repeat(100),
    });
    expect(big.status).toBe(413);
    const ok = await app.request("/text", { method: "POST", headers: { "content-type": "text/plain" }, body: "small" });
    expect(await ok.json()).toEqual({ text: "small" });
  });

  it("leaves bodiless requests alone", async () => {
    const app = new Hono();
    app.use(cappedBody({ maxSize: 1, onError: (c) => c.text("too large", 413) }));
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("/")).status).toBe(200);
  });
});
