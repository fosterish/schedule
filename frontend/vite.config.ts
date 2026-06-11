import { resolve } from "node:path";

import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

const inTest = !!process.env.VITEST;
const r = (p: string) => resolve(process.cwd(), p);

// Prod is proxied under `/schedule/`; dev proxies `/api` to the backend on :3000.
export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "/schedule/" : "/",
  // Vitest ignores tsconfig `paths`, so aliases must be declared here too.
  resolve: {
    alias: {
      "@lib": r("src/lib"),
      "@data": r("src/data"),
      "@state": r("src/state"),
      "@ui": r("src/ui"),
      "@bindings": r("src/bindings"),
    },
  },
  plugins: [
    preact(),
    ...(inTest
      ? []
      : [
          VitePWA({
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.ts",
            registerType: "autoUpdate",
            // Register the worker in dev too (it's a TS module), so push can be
            // tested against `npm run dev`. The injected precache manifest is empty.
            devOptions: { enabled: true, type: "module" },
            injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,woff2}"] },
            manifest: {
              name: "Schedule",
              short_name: "Schedule",
              start_url: "/schedule/",
              scope: "/schedule/",
              display: "standalone",
              theme_color: "#0f1115",
              background_color: "#0f1115",
              icons: [
                { src: "pwa-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
                { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
                { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
                { src: "pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
              ],
            },
          }),
        ]),
  ],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3000" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
