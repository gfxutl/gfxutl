interface WindowControlsOverlayApi extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

type OverlayNavigator = Navigator & {
  windowControlsOverlay?: WindowControlsOverlayApi;
  userAgentData?: { platform?: string };
};

function hostPlatform() {
  const browserNavigator = navigator as OverlayNavigator;
  return browserNavigator.userAgentData?.platform || navigator.platform || "";
}

/**
 * Mirrors the native caption geometry into layout variables. The native controls
 * remain owned by the browser; the editor only consumes the unobscured titlebar.
 */
export function observeWindowControlsOverlay(root: HTMLElement) {
  const overlay = (navigator as OverlayNavigator).windowControlsOverlay;
  if (!overlay) return () => undefined;

  const update = () => {
    let rect: DOMRect;
    try {
      rect = overlay.getTitlebarAreaRect();
    } catch {
      rect = new DOMRect();
    }
    const active = overlay.visible && rect.height > 0;
    root.classList.toggle("wco-active", active);
    if (!active) {
      root.classList.remove("wco-controls-left", "wco-controls-right");
      delete root.dataset.windowControlsOverlay;
      root.style.removeProperty("--pane-tab-h");
      root.style.removeProperty("--wco-left-inset");
      root.style.removeProperty("--wco-right-inset");
      return;
    }

    const leftInset = Math.max(0, rect.x);
    const rightInset = Math.max(0, window.innerWidth - rect.x - rect.width);
    const platform = hostPlatform();
    const platformIsMac = /mac/i.test(platform);
    const platformHasKnownRightControls = /(win|linux|cros)/i.test(platform);
    const controlsLeft = platformIsMac || (!platformHasKnownRightControls && leftInset > rightInset);

    root.classList.toggle("wco-controls-left", controlsLeft);
    root.classList.toggle("wco-controls-right", !controlsLeft);
    root.dataset.windowControlsOverlay = controlsLeft ? "left" : "right";
    root.style.setProperty("--pane-tab-h", `${rect.height}px`);
    root.style.setProperty("--wco-left-inset", `${leftInset}px`);
    root.style.setProperty("--wco-right-inset", `${rightInset}px`);
  };

  update();
  overlay.addEventListener("geometrychange", update);
  window.addEventListener("resize", update);
  return () => {
    overlay.removeEventListener("geometrychange", update);
    window.removeEventListener("resize", update);
  };
}
