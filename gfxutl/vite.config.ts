import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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
  worker: { format: "es" },
  build: { target: "es2022" },
});
