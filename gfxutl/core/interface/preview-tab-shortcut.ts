export type PreviewTabShortcutTarget =
  | { kind: "view"; view: "inspector" | "camera" }
  | { kind: "clip"; clipId: string };

export interface PreviewTabShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function resolvePreviewTabShortcut(
  event: PreviewTabShortcutKey,
  previewClipIds: readonly string[],
): PreviewTabShortcutTarget | null {
  if (!event.ctrlKey || !event.metaKey || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return null;
  const tabNumber = Number(event.key);
  if (tabNumber === 1) return { kind: "view", view: "inspector" };
  if (tabNumber === 2) return { kind: "view", view: "camera" };
  const clipId = previewClipIds[tabNumber - 3];
  return clipId ? { kind: "clip", clipId } : null;
}
