import type { FontFaceInfo } from "../interface/types";

const GOOGLE_FONTS_CDN_ROOT = "https://cdn.jsdelivr.net/gh/google/fonts@main/";
export const GOOGLE_FONTS_CATALOG_URL = `${GOOGLE_FONTS_CDN_ROOT}.ci/family_features.json`;

type GoogleFontsCatalogPayload = {
  families?: Record<string, { fp?: unknown }>;
};

let catalogLoad: Promise<FontFaceInfo[]> | undefined;
const fontLoads = new Map<string, Promise<Blob>>();

export function loadGoogleFontCatalog() {
  if (catalogLoad) return catalogLoad;
  catalogLoad = fetch(GOOGLE_FONTS_CATALOG_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Google Fonts catalog request failed (${response.status})`);
      return parseGoogleFontsCatalog(await response.json());
    })
    .catch((error) => {
      catalogLoad = undefined;
      throw error;
    });
  return catalogLoad;
}

export function loadGoogleFontData(catalogPath: string, family?: string) {
  const normalizedPath = normalizeGoogleFontsPath(catalogPath);
  if (!normalizedPath?.toLowerCase().endsWith(".ttf")) return Promise.reject(new Error("Invalid Google Fonts path"));
  const cached = fontLoads.get(normalizedPath);
  if (cached) return cached;
  const pending = resolvePreferredFontPath(normalizedPath, family)
    .then(fetchGoogleFontBlob)
    .catch((error) => {
      fontLoads.delete(normalizedPath);
      throw error;
    });
  fontLoads.set(normalizedPath, pending);
  return pending;
}

export function parseGoogleFontsCatalog(value: unknown): FontFaceInfo[] {
  const families = value && typeof value === "object"
    ? (value as GoogleFontsCatalogPayload).families
    : undefined;
  if (!families || typeof families !== "object") throw new Error("Invalid Google Fonts catalog");

  return Object.entries(families)
    .flatMap(([family, metadata]) => {
      const path = normalizeGoogleFontsPath(metadata?.fp);
      if (!family.trim() || !path) return [];
      return [{
        postscriptName: `google-fonts:${family}`,
        fullName: family,
        family,
        style: "Regular",
        source: "google" as const,
        googleFontsPath: path,
      }];
    })
    .sort((left, right) => left.family.localeCompare(right.family));
}

export function parseGoogleFontsMetadata(metadata: string, fallbackPath: string) {
  const directory = fallbackPath.slice(0, fallbackPath.lastIndexOf("/") + 1);
  const faces = [...metadata.matchAll(/(?:^|\n)\s*fonts\s*\{([^{}]*)\}/g)]
    .map((match) => ({
      filename: protobufString(match[1], "filename"),
      style: protobufString(match[1], "style") ?? "normal",
      weight: Number(protobufNumber(match[1], "weight") ?? 400),
    }))
    .filter((face): face is { filename: string; style: string; weight: number } => (
      typeof face.filename === "string"
      && !face.filename.includes("/")
      && face.filename.toLowerCase().endsWith(".ttf")
    ));
  const preferred = faces.sort((left, right) => {
    const leftScore = (left.style === "normal" ? 0 : 10_000) + Math.abs(left.weight - 400);
    const rightScore = (right.style === "normal" ? 0 : 10_000) + Math.abs(right.weight - 400);
    return leftScore - rightScore;
  })[0];
  return preferred ? `${directory}${preferred.filename}` : fallbackPath;
}

export function googleFontsCdnUrl(path: string) {
  const normalizedPath = normalizeGoogleFontsPath(path);
  if (!normalizedPath) throw new Error("Invalid Google Fonts path");
  return `${GOOGLE_FONTS_CDN_ROOT}${normalizedPath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeGoogleFontsPath(value: unknown) {
  if (typeof value !== "string") return undefined;
  const path = value.replace(/^\.\//, "");
  const segments = path.split("/");
  if (segments.length < 3 || !["apache", "ofl", "ufl"].includes(segments[0].toLowerCase())) return undefined;
  if (!/^[a-z0-9_-]+$/i.test(segments[1]) || segments.some((segment) => !segment || segment === "." || segment === ".." || /[?#]/.test(segment))) return undefined;
  if (!/\.ttf$/i.test(segments.at(-1)!) && !(segments.length === 3 && segments[2] === "METADATA.pb")) return undefined;
  return path;
}

async function resolvePreferredFontPath(fallbackPath: string, family?: string) {
  const [license, catalogFamily] = fallbackPath.split("/");
  const expectedFamily = family?.trim();
  const expectedDirectory = expectedFamily
    ? `${license}/${expectedFamily.toLowerCase().replace(/[^a-z0-9]/g, "")}/`
    : undefined;
  const catalogDirectory = `${license}/${catalogFamily}/`;
  const directories = [...new Set([expectedDirectory, catalogDirectory].filter((directory): directory is string => Boolean(directory)))];

  for (const directory of directories) {
    try {
      const response = await fetch(googleFontsCdnUrl(`${directory}METADATA.pb`));
      if (!response.ok) continue;
      const metadata = await response.text();
      const metadataFamily = protobufString(metadata, "name");
      if (expectedFamily && normalizeFamilyName(metadataFamily) !== normalizeFamilyName(expectedFamily)) continue;
      const filename = fallbackPath.slice(fallbackPath.lastIndexOf("/") + 1);
      return parseGoogleFontsMetadata(metadata, `${directory}${filename}`);
    } catch {
      // Try the catalog directory and finally the representative file itself.
    }
  }
  return fallbackPath;
}

async function fetchGoogleFontBlob(path: string) {
  const response = await fetch(googleFontsCdnUrl(path));
  if (!response.ok) throw new Error(`Google Font request failed (${response.status})`);
  return response.blob();
}

function protobufString(block: string, field: string) {
  const match = new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(block);
  return match?.[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function protobufNumber(block: string, field: string) {
  return new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(block)?.[1];
}

function normalizeFamilyName(value: string | undefined) {
  return value?.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "") ?? "";
}
