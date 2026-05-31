import { defineConfig } from "vite";

// In production the app is reverse-proxied under `/schedule/` (the proxy strips
// that prefix before forwarding), so the build must emit asset/route URLs under
// that base. `import.meta.env.BASE_URL` carries it to the router and API client.
// In dev, Vite serves at root and proxies API/auth calls to the backend on :3000
// so cookies and same-origin requests behave exactly as they do in production.
export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "/schedule/" : "/",
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
}));
