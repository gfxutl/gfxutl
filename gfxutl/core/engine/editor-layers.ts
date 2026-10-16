export const TRANSFORM_HANDLES_LAYER = 30;
export const INSPECTOR_HELPERS_LAYER = 31;

/** Keep picking limited to objects that are actually visible in the active preview. */
export function matchPreviewLayerMask(
  picker: { layers: { mask: number } },
  camera: { layers: { mask: number } },
) {
  picker.layers.mask = camera.layers.mask;
}
