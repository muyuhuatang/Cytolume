import { defineConfig } from "vite";
import { resolve } from "node:path";

// App (showcase) build for DEPLOYMENT — distinct from the library build in
// vite.config.ts (which is lib mode → dist/cytolume.js). This bundles the
// showcase: index.html + main.ts/main3d.ts + everything under public/ (incl. the
// ~42 MB spine/ tiles, copied verbatim) into a static site under dist-app/.
//   npm run build:app     → dist-app/
//   npm run preview:app   → serve it locally
// BASE_PATH=/Cytolume/ supports GitHub project Pages; a domain root uses "/".
// Data loading and the local HRA snapshot follow the same Vite base URL.
export default defineConfig({
  base: process.env.BASE_PATH || "/",
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
    outDir: "dist-app",
    emptyOutDir: true,
    sourcemap: false,
  },
});
