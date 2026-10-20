export interface EditorShortcutTarget {
  tagName: string;
  inputType?: string;
  contentEditable?: boolean;
  insideInspector?: boolean;
}

const PROPERTY_INPUT_TYPES = new Set(["number", "range", "checkbox", "radio", "color"]);

/** Keeps native text undo intact while routing inspector property controls to project history. */
export function shouldHandleEditorHistoryShortcut(target?: EditorShortcutTarget | null) {
  if (!target) return true;
  const tagName = target.tagName.toLowerCase();
  if (target.contentEditable || tagName === "textarea") return false;
  if (tagName === "select") return Boolean(target.insideInspector);
  if (tagName !== "input") return true;
  return Boolean(target.insideInspector && PROPERTY_INPUT_TYPES.has((target.inputType ?? "text").toLowerCase()));
}
