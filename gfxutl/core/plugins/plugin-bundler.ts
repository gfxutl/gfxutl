import type { OutputChunk, Plugin as RolldownPlugin } from "@rolldown/browser";
import { normalizePluginPath, resolveRendererPluginEntry, resolveVirtualModule } from "./plugin-package";
import type { RendererPluginBundle, RendererPluginPackage } from "./plugin-types";

const ENTRY_ID = "\0gfxutl-renderer-plugin-entry";

export async function bundleRendererPlugin(source: RendererPluginPackage): Promise<RendererPluginBundle> {
  const { rolldown } = await import("@rolldown/browser");
  const bundle = await rolldown({
    input: ENTRY_ID,
    platform: "browser",
    treeshake: true,
    plugins: [virtualPackagePlugin(source)],
  });
  try {
    const generated = await bundle.generate({
      format: "iife",
      name: "__gfxutlPluginExports",
      exports: "named",
      inlineDynamicImports: true,
      sourcemap: false,
    });
    const chunk = generated.output.find((item): item is OutputChunk => item.type === "chunk" && item.isEntry);
    if (!chunk) throw new Error("Oxc/Rolldownがエントリーチャンクを生成しませんでした");
    return {
      id: source.id,
      name: source.name,
      version: source.version,
      entry: source.entry,
      moduleCount: source.files.length,
      code: chunk.code,
    };
  } finally {
    await bundle.close();
  }
}

function virtualPackagePlugin(source: RendererPluginPackage): RolldownPlugin {
  const files = new Map(source.files.map((file) => [normalizePluginPath(file.path), file.source]));
  const fileList = source.files.map((file) => ({ ...file, path: normalizePluginPath(file.path) }));
  const entry = resolveVirtualModule(source.entry, fileList);
  if (!entry) throw new Error(`エントリーポイント ${source.entry} が見つかりません`);
  return {
    name: "gfxutl-renderer-plugin-files",
    resolveId(specifier, importer) {
      if (specifier === ENTRY_ID) return `/${entry}`;
      if (specifier.startsWith("\0")) return null;
      const resolved = resolveImport(specifier, importer?.replace(/^\//, ""), files, fileList);
      if (!resolved) throw new Error(`プラグイン内で解決できないimportです: ${specifier}${importer ? ` (${importer})` : ""}`);
      return `/${resolved}`;
    },
    load(id) {
      const path = id.replace(/^\//, "");
      const contents = files.get(path);
      if (contents === undefined) return null;
      if (path.endsWith(".json")) return { code: `export default ${contents.trim()};`, moduleType: "js" };
      return contents;
    },
  };
}

function resolveImport(specifier: string, importer: string | undefined, files: Map<string, string>, fileList: RendererPluginPackage["files"]) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/") ? "" : dirname(importer ?? "");
    return resolveVirtualModule(joinPath(base, specifier), fileList);
  }
  const packageParts = specifier.startsWith("@") ? specifier.split("/").slice(0, 2) : specifier.split("/").slice(0, 1);
  const packageName = packageParts.join("/");
  const subpath = specifier.slice(packageName.length).replace(/^\//, "");
  let directory = dirname(importer ?? "");
  while (true) {
    const packageRoot = joinPath(directory, `node_modules/${packageName}`);
    const manifestSource = files.get(`${packageRoot}/package.json`);
    if (manifestSource) {
      if (subpath) return resolveVirtualModule(`${packageRoot}/${subpath}`, fileList);
      try {
        const entry = resolveRendererPluginEntry(JSON.parse(manifestSource) as never);
        return resolveVirtualModule(`${packageRoot}/${entry}`, fileList);
      } catch {
        return resolveVirtualModule(`${packageRoot}/index`, fileList);
      }
    }
    if (!directory) break;
    directory = dirname(directory);
  }
  return undefined;
}

function dirname(path: string) {
  const normalized = normalizePluginPath(path);
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
}

function joinPath(base: string, path: string) {
  return normalizePluginPath(`${base}/${path}`);
}
