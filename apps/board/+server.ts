import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import vike from "@vikejs/hono";
import type { Server } from "vike/types";
import { app } from "./server/index.js";

vike(app);

const server = {
  fetch: app.fetch,
} satisfies Server;

export default server;

if (startedAsProcess()) {
  const port = listenPort();
  serve({ fetch: app.fetch, port }, (info) => {
    console.info(`Snoboard listening on ${info.port}`);
  });
}

function startedAsProcess(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return false;
  const current = path.resolve(fileURLToPath(import.meta.url));
  const invoked = path.resolve(entry);
  if (process.platform === "win32") return invoked.toLowerCase() === current.toLowerCase();
  return invoked === current;
}

function listenPort(): number {
  const fromPort = process.env.PORT?.trim();
  if (fromPort !== undefined && fromPort.length > 0) {
    const port = Number(fromPort);
    if (Number.isInteger(port) && port > 0) return port;
  }
  const publicUrl = process.env.SNOBOARD_PUBLIC_URL?.trim();
  if (publicUrl !== undefined && publicUrl.length > 0) {
    try {
      const url = new URL(publicUrl);
      if (url.port.length > 0) {
        const port = Number(url.port);
        if (Number.isInteger(port) && port > 0) return port;
      }
    } catch {
      return 3000;
    }
  }
  return 3000;
}
