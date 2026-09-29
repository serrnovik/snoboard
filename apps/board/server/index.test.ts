import { describe, expect, it } from "vitest";
import { app } from "./index.js";

describe("GET /healthz", () => {
  it("returns 200 ok", async () => {
    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
