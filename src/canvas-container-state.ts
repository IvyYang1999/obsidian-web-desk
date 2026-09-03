export type CanvasContainerAppearanceFlag = "showBorder" | "showFill";

export interface CanvasContainerAppearanceTarget {
  color: string;
  showBorder?: boolean;
  showFill?: boolean;
}

export function canvasContainerAppearance(
  target: Pick<CanvasContainerAppearanceTarget, "showBorder" | "showFill">,
): { showBorder: boolean; showFill: boolean } {
  return {
    showBorder: target.showBorder === true,
    showFill: target.showFill === true,
  };
}

export function toggleCanvasContainerAppearance(
  target: CanvasContainerAppearanceTarget,
  flag: CanvasContainerAppearanceFlag,
): boolean {
  const enabled = target[flag] !== true;
  if (enabled) target[flag] = true;
  else delete target[flag];
  return enabled;
}
