import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { api } from "./api.js";
import { bootAuth } from "./auth/env.js";
import { githubRouter } from "./auth/github.js";
import { authMiddleware, type BoardEnv } from "./auth/middleware.js";
import { passwordRouter } from "./auth/password.js";
import { startRepoSyncIfConfigured } from "./repo-sync.js";
import { getSnapshot } from "./store.js";

export const app = new Hono<BoardEnv>();

bootAuth(process.env);

// Every endpoint takes at most a small form or JSON body. bodyLimit counts
// the bytes actually read, so chunked bodies without Content-Length are capped too.
export const MAX_BODY_BYTES = 8 * 1024;
app.use(
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "payload too large" }, 413),
  }),
);
app.use(authMiddleware);
app.route("/auth", passwordRouter);
app.route("/auth", githubRouter);

app.get("/healthz", (c) => c.text("ok"));

app.get("/readyz", (c) => {
  if (getSnapshot() === null) {
    return c.text("not ready", 503);
  }
  return c.text("ok");
});

app.route("/api", api);

startRepoSyncIfConfigured();
