import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

const shared = { "@shared": resolve(import.meta.dirname, "src/shared") };

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: {
    resolve: { alias: shared },
    // Sandboxed preloads must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    resolve: { alias: { ...shared, "@renderer": resolve(import.meta.dirname, "src/renderer/src") } },
    plugins: [react()],
  },
});
