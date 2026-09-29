// tsc only emits JavaScript; ship the built-in initiative template with dist.
import { cpSync } from "node:fs";

cpSync(new URL("../src/templates", import.meta.url), new URL("../dist/templates", import.meta.url), {
  recursive: true,
});
