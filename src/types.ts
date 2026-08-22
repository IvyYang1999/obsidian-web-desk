import type { App } from "obsidian";

/** 画布上的分组框（命名矩形区域），存插件 data.json。 */
export interface GroupBox {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** 画布上的文本框（备注），存插件 data.json。 */
export interface TextBox {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
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
}

export const DEFAULT_SETTINGS: WebDeskSettings = {
  bookmarkFolder: "收藏夹",
  imageFolder: "附件/网页桌面",
  defaultIconSize: 96,
};

/** 画布上单个收藏（一个 md 文件）的投影。 */
export interface BookmarkCard {
  path: string;
  title: string;
  url: string;
  host: string;
  type: string;
  description: string;
  x: number;
  y: number;
  size: number;
  group: string;
  objectGroup: string;
  /** 是否有手动布局（frontmatter 里有 desk_x/desk_y）。 */
  placed: boolean;
}

export const VIEW_TYPE_WEB_DESK = "web-desk-view";

export const SIZE_SMALL = 72;
export const SIZE_MEDIUM = 96;
export const SIZE_LARGE = 128;

export const GROUP_COLORS = [
  "#7aa2f7",
  "#9ece6a",
  "#e0af68",
  "#bb9af7",
  "#f7768e",
  "#7dcfff",
  "#9aa5ce",
];

export const CANVAS_BOUND = 10000;

export interface PluginContext {
  app: App;
  settings: WebDeskSettings;
}
