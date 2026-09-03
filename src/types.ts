import type { App } from "obsidian";
import type { CardViewMode } from "./card-view-state";
import type { CardStyle } from "./canvas-ui-state";

/** 分组与文本框共享的可选容器外观；缺字段代表干净的无容器模式。 */
export interface CanvasContainerAppearance {
  color: string;
  showBorder?: boolean;
  showFill?: boolean;
}

/** 画布上的命名区域；代码和旧数据仍沿用 GroupBox，界面统一称“区域”。 */
export interface GroupBox extends CanvasContainerAppearance {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 画布上的文本框（备注），存插件 data.json。 */
export interface TextBox extends CanvasContainerAppearance {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 空间区域归属；与 Figma 式逻辑组合相互独立。 */
  group?: string;
  /** Figma 式逻辑组合；与分类分组框无关。 */
  objectGroup?: string;
}

/** 画布图片：文件本体在 Vault，这里只保存相对路径与布局。 */
export interface CanvasImage {
  id: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 空间区域归属；与 Figma 式逻辑组合相互独立。 */
  group?: string;
  objectGroup?: string;
}

/** 评分可独立存在，也可保存一个网页引用；引用失效时保留评分本身。 */
export interface RatingLink {
  ref: string;
  title: string;
  url: string;
}

export interface Rating {
  id: string;
  value: number;
  x: number;
  y: number;
  link?: RatingLink;
  /** 空间区域归属；与 Figma 式逻辑组合相互独立。 */
  group?: string;
  /** 评分没有独立缩放手柄；组合缩放通过该比例持久化。 */
  scale?: number;
  objectGroup?: string;
}

/** 两种画布共享的组件协议；宿主只负责决定写入 data.json 还是代码块 JSON。 */
export interface CanvasComponents {
  images: CanvasImage[];
  textboxes: TextBox[];
  groups: GroupBox[];
  arrows: Arrow[];
  ratings: Rating[];
}

/** 箭头端点：card=md路径 / textbox·group=id / point="x,y"。 */
export type ArrowEndpointKind = "card" | "textbox" | "group" | "point";

export interface ArrowEndpoint {
  kind: ArrowEndpointKind;
  ref: string;
}

export interface Arrow {
  id: string;
  from: ArrowEndpoint;
  to: ArrowEndpoint;
  label: string;
  /** 空 = 主题色；否则 GROUP_COLORS 之一。 */
  color: string;
}

/** 画布平移/缩放状态，随 data.json 持久化。 */
export interface CanvasTransform {
  panX: number;
  panY: number;
  zoom: number;
}

export interface WebDeskSettings {
  bookmarkFolder: string;
  imageFolder: string;
  defaultIconSize: number;
  /** 已由响应头确认禁止 iframe 的站点；避免反复尝试空白嵌入。 */
  blockedEmbedHosts: string[];
}

/** 网页卡片自身的内容属性；不占用画布上的独立组件。 */
export interface CardProperties {
  title: string;
  rating: number;
  note: string;
}

export const DEFAULT_SETTINGS: WebDeskSettings = {
  bookmarkFolder: "收藏夹",
  imageFolder: "附件/网页桌面",
  defaultIconSize: 96,
  blockedEmbedHosts: [],
};

/** 画布上单个收藏（一个 md 文件）的投影。 */
export interface BookmarkCard {
  path: string;
  /** 文件卡片指向的 Vault 内 Markdown；空字符串表示普通网页收藏。 */
  targetPath: string;
  title: string;
  url: string;
  host: string;
  type: string;
  description: string;
  previewImage: string;
  rating: number;
  note: string;
  /** 始终可见于卡片下方的公开说明；与内部备注分离。 */
  caption: string;
  x: number;
  y: number;
  size: number;
  viewMode: CardViewMode;
  cardStyle: CardStyle;
  previewWidth: number;
  previewHeight: number;
  group: string;
  objectGroup: string;
  /** 是否有手动布局（frontmatter 里有 desk_x/desk_y）。 */
  placed: boolean;
}

export const VIEW_TYPE_WEB_DESK = "web-desk-view";

export const SIZE_SMALL = 72;
export const SIZE_MEDIUM = 96;
export const SIZE_LARGE = 128;

export const GROUP_COLOR_PRESETS = [
  { name: "蓝色", value: "#7aa2f7" },
  { name: "绿色", value: "#9ece6a" },
  { name: "琥珀色", value: "#e0af68" },
  { name: "紫色", value: "#bb9af7" },
  { name: "玫红色", value: "#f7768e" },
  { name: "青色", value: "#7dcfff" },
  { name: "灰蓝色", value: "#9aa5ce" },
] as const;

export const GROUP_COLORS = GROUP_COLOR_PRESETS.map((preset) => preset.value);

export const CANVAS_BOUND = 10000;

export interface PluginContext {
  app: App;
  settings: WebDeskSettings;
}
