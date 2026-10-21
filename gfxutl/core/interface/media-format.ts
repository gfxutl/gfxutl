export type ImportMediaKind = "video" | "audio" | "image" | "model";

const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "aac", "flac"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg", "hdr", "exr"]);
const TEXTURE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const BROWSER_PREVIEW_IMAGE_EXTENSIONS = new Set([...TEXTURE_IMAGE_EXTENSIONS, "svg"]);

export const SUPPORTED_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4", "mov", "webm", "mkv",
  ...AUDIO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  "glb", "gltf",
]);

function fileExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function isSvgImageFile(file: Pick<File, "name" | "type">) {
  return file.type.toLowerCase() === "image/svg+xml" || fileExtension(file.name) === "svg";
}

export function mediaKindForFile(file: Pick<File, "name" | "type">): ImportMediaKind | null {
  const extension = fileExtension(file.name);
  const mimeType = file.type.toLowerCase();
  if (!SUPPORTED_MEDIA_EXTENSIONS.has(extension) && !mimeType.startsWith("video/") && !mimeType.startsWith("audio/") && !mimeType.startsWith("image/")) return null;
  if (extension === "glb" || extension === "gltf" || mimeType === "model/gltf-binary" || mimeType === "model/gltf+json") return "model";
  if (mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (mimeType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) return "image";
  return "video";
}

export function isTextureImageFile(file: Pick<File, "name" | "type">) {
  const extension = fileExtension(file.name);
  const mimeType = file.type.toLowerCase();
  return TEXTURE_IMAGE_EXTENSIONS.has(extension)
    || ["image/png", "image/jpeg", "image/webp"].includes(mimeType);
}

export function isImportImageName(name: string) {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}

export function isBrowserPreviewImageName(name: string) {
  return BROWSER_PREVIEW_IMAGE_EXTENSIONS.has(fileExtension(name));
}
