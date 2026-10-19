/** Returns the native device pixel ratio without reducing high-density displays. */
export function nativePreviewPixelRatio(devicePixelRatio: number) {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
}
