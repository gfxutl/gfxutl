import type { RenderClip, SceneObjectSpec, SceneSettings } from "../protocol/engine-protocol";

const MATERIAL_ASSET_KEYS = [
  "mapAssetId",
  "normalMapAssetId",
  "roughnessMapAssetId",
  "metalnessMapAssetId",
  "emissiveMapAssetId",
  "alphaMapAssetId",
  "aoMapAssetId",
] as const;

export function collectExportAssetIds(clips: readonly RenderClip[], sceneSettings: SceneSettings, objects: Iterable<SceneObjectSpec> = []) {
  const assetIds = new Set<string>();
  const add = (assetId: string | undefined) => { if (assetId) assetIds.add(assetId); };
  const addMaterial = (object: SceneObjectSpec | undefined) => {
    for (const key of MATERIAL_ASSET_KEYS) add(object?.material?.[key]);
  };
  add(sceneSettings.background.backgroundAssetId);
  add(sceneSettings.background.environmentAssetId);
  for (const clip of clips) {
    add(clip.assetId);
    addMaterial(clip.sceneObject);
  }
  for (const object of objects) addMaterial(object);
  return [...assetIds];
}
