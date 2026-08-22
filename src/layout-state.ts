export interface DeskPatch {
  x?: number | null;
  y?: number | null;
  size?: number | null;
  group?: string | null;
  objectGroup?: string | null;
}

export interface RecentLayoutWrite {
  x: number;
  y: number;
  size?: number;
  at: number;
  objectGroup?: string;
}

interface LayoutCardState {
  x: number;
  y: number;
  size: number;
  placed: boolean;
  objectGroup?: string;
}

type RecentLayoutResult = "applied" | "expired";

/**
 * 将局部布局补丁应用到 frontmatter。
 * undefined 表示调用方没有更新该字段；null 才表示显式删除。
 */
export function applyDeskPatch(fm: Record<string, unknown>, patch: DeskPatch): void {
  if (patch.x !== undefined) assign(fm, "desk_x", patch.x);
  if (patch.y !== undefined) assign(fm, "desk_y", patch.y);
  if (patch.size !== undefined) assign(fm, "desk_size", patch.size);
  if (patch.group !== undefined) assign(fm, "desk_group", patch.group);
  if (patch.objectGroup !== undefined) assign(fm, "desk_object_group", patch.objectGroup);
}

/**
 * metadataCache 暂时滞后时，以近期成功写盘的布局为准。
 * 同时恢复 placed，避免刷新把已放置卡片误送进自动排布。
 */
export function applyRecentLayoutWrite(
  card: LayoutCardState,
  write: RecentLayoutWrite,
  now: number,
  ttlMs = 10_000,
): RecentLayoutResult {
  if (now - write.at > ttlMs) return "expired";
  card.x = write.x;
  card.y = write.y;
  if (write.size !== undefined) card.size = write.size;
  card.placed = true;
  if (write.objectGroup !== undefined) card.objectGroup = write.objectGroup;
  return "applied";
}

function assign(fm: Record<string, unknown>, key: string, value: number | string | null): void {
  if (value === null) {
    delete fm[key];
    return;
  }
  fm[key] = typeof value === "number" ? Math.round(value) : value;
}
