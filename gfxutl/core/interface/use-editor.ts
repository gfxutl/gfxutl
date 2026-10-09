import { useSyncExternalStore } from "react";
import { editorController } from "../runtime";

export function useEditor() {
  const state = useSyncExternalStore(editorController.subscribe, editorController.getSnapshot);
  return { state, controller: editorController };
}
