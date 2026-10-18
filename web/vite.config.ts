import { defineConfig } from "vite";
import { resolve } from "node:path";

// Cytolume builds two ways:
//   - `vite` / `vite preview`  → the showcase app (index.html at root)
//   - `vite build`             → the library bundle (src/core/index.ts)
// The showcase is the portfolio artifact; the library is the deliverable.
export default defineConfig({
  resolve: {
    alias: {
      "@core": resolve(__dirname, "src/core"),
      "@data": resolve(__dirname, "src/data"),
      "@biology": resolve(__dirname, "src/biology"),
      "@ui": resolve(__dirname, "src/ui"),
    },
  },
  build: {
    target: "es2022",
    lib: {
      entry: resolve(__dirname, "src/core/index.ts"),
      name: "Cytolume",
      fileName: "cytolume",
      formats: ["es"],
    },
  },
});
