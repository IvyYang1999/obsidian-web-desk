export interface DeskPatch {
  x?: number | null;
  y?: number | null;
  size?: number | null;
  group?: string | null;
  objectGroup?: string | null;
  viewMode?: string | null;
  cardStyle?: string | null;
  previewWidth?: number | null;
  previewHeight?: number | null;
  hidden?: boolean | null;
}

export interface RecentLayoutWrite {
  x: number;
  y: number;
  size?: number;
  at: number;
  group?: string;
  objectGroup?: string;
  viewMode?: "icon" | "preview" | "embed";
  cardStyle?: "visual" | "article" | "compact";
  previewWidth?: number;
  previewHeight?: number;
}

interface LayoutCardState {
  x: number;
  y: number;
  size: number;
  placed: boolean;
  group?: string;
  objectGroup?: string;
  viewMode?: "icon" | "preview" | "embed";
  cardStyle?: "visual" | "article" | "compact";
  previewWidth?: number;
  previewHeight?: number;
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
  if (patch.viewMode !== undefined) assign(fm, "desk_view_mode", patch.viewMode);
  if (patch.cardStyle !== undefined) assign(fm, "desk_card_style", patch.cardStyle);
  if (patch.previewWidth !== undefined) assign(fm, "desk_preview_width", patch.previewWidth);
  if (patch.previewHeight !== undefined) assign(fm, "desk_preview_height", patch.previewHeight);
  if (patch.hidden !== undefined) assign(fm, "desk_hidden", patch.hidden);
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
  if (write.group !== undefined) card.group = write.group;
  if (write.objectGroup !== undefined) card.objectGroup = write.objectGroup;
  if (write.viewMode !== undefined) card.viewMode = write.viewMode;
  if (write.cardStyle !== undefined) card.cardStyle = write.cardStyle;
  if (write.previewWidth !== undefined) card.previewWidth = write.previewWidth;
  if (write.previewHeight !== undefined) card.previewHeight = write.previewHeight;
  return "applied";
}

function assign(fm: Record<string, unknown>, key: string, value: number | string | boolean | null): void {
  if (value === null) {
    delete fm[key];
    return;
  }
  fm[key] = typeof value === "number" ? Math.round(value) : value;
}
