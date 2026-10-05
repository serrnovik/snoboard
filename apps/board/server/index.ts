import { cappedBody } from "./body-limit.js";
import { Hono } from "hono";
import { api } from "./api.js";
import { bootAuth } from "./auth/env.js";
import { bootWriteTokens } from "./auth/write-tokens.js";
import { bootEditConfig } from "./edit-env.js";
import { MAX_SUBMIT_BODY_BYTES } from "snoboard";
import { MAX_VALIDATE_BODY_BYTES } from "./edits/prepare.js";
import { githubRouter } from "./auth/github.js";
import { ISSUE_CREATE_MAX_BODY_BYTES } from "./issues/create.js";
import { authMiddleware, type BoardEnv } from "./auth/middleware.js";
import { passwordRouter } from "./auth/password.js";
import { startRepoSyncIfConfigured } from "./repo-sync.js";
import { isBoardReady } from "./store.js";

export const app = new Hono<BoardEnv>();

bootAuth(process.env);
bootWriteTokens();
bootEditConfig(process.env);

// Every endpoint takes at most a small form or JSON body. cappedBody counts
// the bytes actually read, so chunked bodies without Content-Length are capped too.
// Edit validation sends a batch, so it allows a larger body. Submit also carries
// image attachments (base64), so only that route allows MAX_SUBMIT_BODY_BYTES.
export const MAX_BODY_BYTES = 8 * 1024;
const EDIT_VALIDATE_PATH = /^\/api\/(?:repos\/[a-z0-9-]{1,32}\/)?edits\/validate$/;
const EDIT_SUBMIT_PATH = /^\/api\/(?:repos\/[a-z0-9-]{1,32}\/)?edits\/submit$/;
const ISSUE_CREATE_PATH = /^\/api\/repos\/[a-z0-9-]{1,32}\/issues\/create$/;

const smallBody = cappedBody({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: "payload too large" }, 413),
});
const validateBody = cappedBody({
  maxSize: MAX_VALIDATE_BODY_BYTES,
  onError: (c) => c.json({ error: "payload too large" }, 413),
});
// A new issue carries up to 20 000 characters of markdown.
const issueBody = cappedBody({
  maxSize: ISSUE_CREATE_MAX_BODY_BYTES,
  onError: (c) => c.json({ ok: false, code: "too_large", error: "payload too large" }, 413),
});
const submitBody = cappedBody({
  maxSize: MAX_SUBMIT_BODY_BYTES,
  onError: (c) =>
    c.json(
      { ok: false, code: "too_large", error: "the submit is too large; images are limited to 8 MB per submit" },
      413,
    ),
});
app.use((c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (EDIT_SUBMIT_PATH.test(pathname)) return submitBody(c, next);
  if (EDIT_VALIDATE_PATH.test(pathname)) return validateBody(c, next);
  if (ISSUE_CREATE_PATH.test(pathname)) return issueBody(c, next);
  return smallBody(c, next);
});
app.use(authMiddleware);
app.route("/auth", passwordRouter);
app.route("/auth", githubRouter);

app.get("/healthz", (c) => c.text("ok"));

app.get("/readyz", (c) => {
  // Every configured repo must have a first snapshot or a recorded error.
  if (!isBoardReady()) {
    return c.text("not ready", 503);
  }
  return c.text("ok");
});

app.route("/api", api);

startRepoSyncIfConfigured();
