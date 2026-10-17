import { EditorController } from "./interface/editor-controller";

// Composition root: this is the only module that knows both halves. The UI and
// renderer communicate exclusively through the transferred MessageChannel.
export const editorController = new EditorController(() => new Worker(new URL("./engine/media.worker.ts", import.meta.url), {
  type: "module",
  name: "gfxutl-media-graphics",
}));
