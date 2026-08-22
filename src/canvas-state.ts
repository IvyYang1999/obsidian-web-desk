import type { Arrow, ArrowEndpoint, GroupBox, TextBox } from "./types";

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasRect extends CanvasPoint {
  w: number;
  h: number;
}

export interface CanvasCardRect extends CanvasRect {
  ref: string;
  group?: string;
}

export interface CanvasEndpointScene {
  cards: CanvasCardRect[];
  textboxes: TextBox[];
  groups: GroupBox[];
}

interface CreateGroupBoxOptions {
  id: string;
  name: string;
  point: CanvasPoint;
  color: string;
  width?: number;
  height?: number;
  centered?: boolean;
}

export function createGroupBox(options: CreateGroupBoxOptions): GroupBox {
  const w = options.width ?? 480;
  const h = options.height ?? 360;
  return {
    id: options.id,
    name: options.name,
    x: Math.round(options.point.x - (options.centered ? w / 2 : 0)),
    y: Math.round(options.point.y - (options.centered ? h / 2 : 0)),
    w,
    h,
    color: options.color,
  };
}

export function groupAtPoint(groups: GroupBox[], point: CanvasPoint): string {
  const group = groups.find((entry) =>
    point.x >= entry.x && point.x <= entry.x + entry.w &&
    point.y >= entry.y && point.y <= entry.y + entry.h
  );
  return group?.name ?? "";
}

export function recomputeGroupMembership(
  cards: CanvasCardRect[],
  groups: GroupBox[],
): number {
  let changed = 0;
  for (const card of cards) {
    const group = groupAtPoint(groups, {
      x: card.x + card.w / 2,
      y: card.y + card.h / 2,
    });
    if ((card.group ?? "") !== group) {
      card.group = group;
      changed += 1;
    }
  }
  return changed;
}

export function renameGroupMembership(
  cards: Array<{ group?: string }>,
  oldName: string,
  newName: string,
): number {
  let changed = 0;
  for (const card of cards) {
    if (card.group === oldName) {
      card.group = newName;
      changed += 1;
    }
  }
  return changed;
}

export function clearGroupMembership(cards: Array<{ group?: string }>, name: string): number {
  return renameGroupMembership(cards, name, "");
}

export function endpointRect(
  endpoint: ArrowEndpoint,
  scene: CanvasEndpointScene,
): CanvasRect | null {
  if (endpoint.kind === "card") {
    return scene.cards.find((entry) => entry.ref === endpoint.ref) ?? null;
  }
  if (endpoint.kind === "textbox") {
    return scene.textboxes.find((entry) => entry.id === endpoint.ref) ?? null;
  }
  if (endpoint.kind === "group") {
    return scene.groups.find((entry) => entry.id === endpoint.ref) ?? null;
  }
  return null;
}

export function endpointPoint(
  endpoint: ArrowEndpoint,
  scene: CanvasEndpointScene,
): CanvasPoint | null {
  const rect = endpointRect(endpoint, scene);
  if (rect) return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  if (endpoint.kind !== "point") return null;
  const [x, y] = endpoint.ref.split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function arrowLine(
  from: ArrowEndpoint,
  to: ArrowEndpoint,
  scene: CanvasEndpointScene,
): { from: CanvasPoint; to: CanvasPoint } | null {
  const p1 = endpointPoint(from, scene);
  const p2 = endpointPoint(to, scene);
  if (!p1 || !p2) return null;
  const r1 = endpointRect(from, scene);
  const r2 = endpointRect(to, scene);
  return {
    from: r1 ? rectEdgePoint(r1, p2) : p1,
    to: r2 ? rectEdgePoint(r2, p1) : p2,
  };
}

export function pruneDanglingArrows(
  arrows: Arrow[],
  scene: CanvasEndpointScene,
): Arrow[] {
  const alive = (endpoint: ArrowEndpoint): boolean =>
    endpoint.kind === "point"
      ? endpointPoint(endpoint, scene) !== null
      : endpointRect(endpoint, scene) !== null;
  return arrows.filter((arrow) => alive(arrow.from) && alive(arrow.to));
}

export function arrowsWithoutEndpoint(
  arrows: Arrow[],
  endpoint: ArrowEndpoint,
): Arrow[] {
  return arrows.filter((arrow) =>
    !(sameEndpoint(arrow.from, endpoint) || sameEndpoint(arrow.to, endpoint))
  );
}

export function hasArrowBetween(
  arrows: Arrow[],
  from: ArrowEndpoint,
  to: ArrowEndpoint,
): boolean {
  return arrows.some((arrow) =>
    (sameEndpoint(arrow.from, from) && sameEndpoint(arrow.to, to)) ||
    (sameEndpoint(arrow.from, to) && sameEndpoint(arrow.to, from))
  );
}

export function cycleColor(colors: string[], current: string): string {
  const index = colors.indexOf(current);
  return colors[(index + 1) % colors.length] ?? current;
}

function sameEndpoint(a: ArrowEndpoint, b: ArrowEndpoint): boolean {
  return a.kind === b.kind && a.ref === b.ref;
}

function rectEdgePoint(rect: CanvasRect, towards: CanvasPoint): CanvasPoint {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = towards.x - cx;
  const dy = towards.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy);
  const scale = Math.min(sx, sy);
  return { x: cx + dx * scale, y: cy + dy * scale };
}
