import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import vike from "vike/plugin";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), vike()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(root, "src")}/` },
      { find: /^snoboard\/browser$/, replacement: path.resolve(root, "../../packages/core/src/browser.ts") },
      { find: /^snoboard$/, replacement: path.resolve(root, "../../packages/core/src/index.ts") },
    ],
  },
  ssr: {
    noExternal: ["snoboard"],
  },
});
