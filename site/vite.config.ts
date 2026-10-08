import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@yts/shared": resolve(__dirname, "../shared/src"),
    },
  },
  server: {
    proxy: {
      "/yt-proxy": {
        target: "https://www.youtube.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yt-proxy/, ""),
      },
    },
  },
  optimizeDeps: {
    exclude: ["@huggingface/transformers"],
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: resolve(__dirname, "../docs"),
    emptyOutDir: true,
    target: "esnext",
  },
});
