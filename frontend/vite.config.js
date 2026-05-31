import { defineConfig } from "vite";

// In production the Rust backend serves the built `dist/` at the domain root
// (via FRONTEND_DIR + ServeDir with SPA fallback to index.html). In dev, Vite
// serves the app and proxies API/auth calls to the backend on :3000 so cookies
// and same-origin requests behave exactly as they do in production.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
