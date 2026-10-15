import type { RendererPluginFile, RendererPluginPackage } from "./plugin-types";

const SOURCE_EXTENSIONS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "json"]);
const IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn"]);
const MAX_FILES = 4_096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

type PackageManifest = {
  name?: unknown;
  version?: unknown;
  type?: unknown;
  exports?: unknown;
  browser?: unknown;
  module?: unknown;
  main?: unknown;
  gfxutl?: unknown;
};

export async function readRendererPluginPackage(directory: FileSystemDirectoryHandle): Promise<RendererPluginPackage> {
  const manifestFile = await directory.getFileHandle("package.json").then((handle) => handle.getFile()).catch(() => undefined);
  if (!manifestFile) throw new Error("選択したディレクトリのルートに package.json がありません");
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await manifestFile.text()) as PackageManifest;
  } catch {
    throw new Error("package.json を解析できません");
  }
  const entry = resolveRendererPluginEntry(manifest);
  const files: RendererPluginFile[] = [];
  let totalBytes = 0;
  await walkPluginDirectory(directory, "", async (path, file) => {
    const extension = path.split(".").pop()?.toLocaleLowerCase() ?? "";
    if (!SOURCE_EXTENSIONS.has(extension)) return;
    if (file.size > MAX_FILE_BYTES) throw new Error(`${path} がプラグインのファイル上限（4 MiB）を超えています`);
    totalBytes += file.size;
    if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("プラグインが読込上限（64 MiB）を超えています");
    files.push({ path, source: await file.text() });
    if (files.length > MAX_FILES) throw new Error("プラグインのモジュール数が上限（4096）を超えています");
  });
  const resolvedEntry = resolveVirtualModule(entry, files);
  if (!resolvedEntry) throw new Error(`エントリーポイント ${entry} が見つかりません`);
  const packageName = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : directory.name;
  return {
    id: packageName,
    name: packageName,
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    entry: resolvedEntry,
    files,
  };
}

export function resolveRendererPluginEntry(manifest: PackageManifest) {
  const gfxutl = manifest.gfxutl && typeof manifest.gfxutl === "object" ? manifest.gfxutl as Record<string, unknown> : undefined;
  const candidates = [
    typeof gfxutl?.renderer === "string" ? gfxutl.renderer : undefined,
    resolveConditionalExport(manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)
      ? (manifest.exports as Record<string, unknown>)["."] ?? manifest.exports
      : manifest.exports),
    typeof manifest.browser === "string" ? manifest.browser : undefined,
    typeof manifest.module === "string" ? manifest.module : undefined,
    typeof manifest.main === "string" ? manifest.main : undefined,
  ];
  const entry = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  if (!entry) throw new Error("package.json に ESM エントリーポイント（exports/module/browser/main）がありません");
  return normalizePluginPath(entry);
}

export function normalizePluginPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) throw new Error(`パッケージ外のパスは参照できません: ${path}`);
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join("/");
}

export function resolveVirtualModule(path: string, files: readonly RendererPluginFile[]) {
  const normalized = normalizePluginPath(path);
  const paths = new Set(files.map((file) => file.path));
  const candidates = [
    normalized,
    ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "json"].map((extension) => `${normalized}.${extension}`),
    ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "json"].map((extension) => `${normalized}/index.${extension}`),
  ];
  return candidates.find((candidate) => paths.has(candidate));
}

function resolveConditionalExport(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = resolveConditionalExport(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const condition of ["browser", "import", "module", "default"]) {
    const resolved = resolveConditionalExport(record[condition]);
    if (resolved) return resolved;
  }
  return undefined;
}

async function walkPluginDirectory(directory: FileSystemDirectoryHandle, parentPath: string, visit: (path: string, file: File) => Promise<void>) {
  for await (const entry of directory.values()) {
    if (entry.kind === "directory") {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walkPluginDirectory(entry, `${parentPath}${entry.name}/`, visit);
    } else {
      await visit(`${parentPath}${entry.name}`, await entry.getFile());
    }
  }
}
