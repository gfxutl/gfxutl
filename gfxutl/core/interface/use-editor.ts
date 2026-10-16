import { useCallback, useRef, useSyncExternalStore } from "react";
import { editorController } from "../runtime";
import type { EditorState } from "./types";

export function useEditor(): { state: EditorState; controller: typeof editorController };
export function useEditor<T>(selector: (state: EditorState) => T, isEqual?: (left: T, right: T) => boolean): { state: T; controller: typeof editorController };
export function useEditor<T = EditorState>(selector?: (state: EditorState) => T, isEqual: (left: T, right: T) => boolean = Object.is) {
  const selectorRef = useRef(selector ?? ((state: EditorState) => state as T));
  const equalityRef = useRef(isEqual);
  const cacheRef = useRef<{ source: EditorState; value: T } | undefined>(undefined);
  selectorRef.current = selector ?? ((state: EditorState) => state as T);
  equalityRef.current = isEqual;
  const getSelectedSnapshot = useCallback(() => {
    const source = editorController.getSnapshot();
    const cache = cacheRef.current;
    if (cache?.source === source) return cache.value;
    const next = selectorRef.current(source);
    if (cache && equalityRef.current(cache.value, next)) {
      cache.source = source;
      return cache.value;
    }
    cacheRef.current = { source, value: next };
    return next;
  }, []);
  const state = useSyncExternalStore(editorController.subscribe, getSelectedSnapshot, getSelectedSnapshot);
  return { state, controller: editorController };
}

export function shallowEqual<T extends Record<string, unknown>>(left: T, right: T) {
  if (Object.is(left, right)) return true;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.is(left[key], right[key]));
}
