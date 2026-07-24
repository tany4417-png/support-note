/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // ビルド時刻を埋め込む。設定画面に表示し、PCと端末とで表示中のビルドがずれていないかを確認できるようにする
  define: { __APP_VERSION__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "サポートノート",
        short_name: "サポートノート",
        lang: "ja",
        start_url: "/",
        display: "standalone",
        background_color: "#faf7f0",
        theme_color: "#15803d",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { environment: "node", setupFiles: ["./src/test-setup.ts"] },
});
