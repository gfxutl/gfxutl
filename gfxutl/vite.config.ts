import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function chunkFileName(chunk: { facadeModuleId?: string | null }) {
  const objectModule = chunk.facadeModuleId?.match(/\/built-in-objects\/([^/]+)-object\.ts$/);
  return objectModule ? `objects/${objectModule[1]}-[hash].min.js` : "assets/[name]-[hash].js";
}

function offlineAssetManifest(): Plugin {
  return {
    name: "gfxutl-offline-asset-manifest",
    generateBundle(_options, bundle) {
      this.emitFile({ type: "asset", fileName: "asset-manifest.json", source: JSON.stringify(Object.keys(bundle).sort()) });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineAssetManifest()],
  worker: {
    format: "es",
    rollupOptions: { output: { chunkFileNames: chunkFileName } },
  },
  build: {
    target: "es2022",
    minify: "oxc",
    rollupOptions: {
      output: {
        chunkFileNames: chunkFileName,
      },
    },
  },
});
