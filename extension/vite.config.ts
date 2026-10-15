import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@yts/shared": resolve(root, "../shared/src"),
    },
  },
  optimizeDeps: {
    exclude: ["@huggingface/transformers"],
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    sourcemap: false,
    rollupOptions: {
      input: resolve(root, "sidepanel.html"),
    },
  },
  plugins: [
    {
      name: "copy-transformers-wasm",
      apply: "build",
      closeBundle() {
        const source = resolve(root, "../node_modules/@huggingface/transformers/dist");
        const destination = resolve(root, "dist/wasm");
        mkdirSync(destination, { recursive: true });
        // ONNX Runtime loads its WASM glue as a module (ort-wasm-*.mjs) next to the .wasm file.
        for (const file of readdirSync(source)) {
          const isOnnxRuntime = /^ort-wasm.*\.(wasm|mjs)$/.test(file);
          if (file.endsWith(".wasm") || isOnnxRuntime) copyFileSync(join(source, file), join(destination, file));
        }
      },
    },
  ],
});
