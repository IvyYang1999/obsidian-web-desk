# 网页桌面 · 最小设计系统

## 原则

1. 颜色和字体优先使用 Obsidian 语义变量，保证明暗主题与社区主题兼容。
2. `--wd-*` 只表达插件内重复出现的视觉语义，不复制一套独立色板。
3. 原生 `Menu`、`Modal`、`Setting` 和 HTML 按钮优先；自由画布对象才使用自定义组件样式。
4. 新视觉值出现三次以上，或已承担稳定语义时，才提升为 token。

## Tokens

| Token | 用途 |
|---|---|
| `--wd-surface` | 工具条、图片、图标缩略图等浮层表面 |
| `--wd-border-color` | 常规边框与点阵颜色 |
| `--wd-radius-sm/md/lg` | 控件、画布对象、主要容器圆角 |
| `--wd-space-1/2/3` | 4/8/12px 重复间距 |
| `--wd-shadow-sm/md` | 静止态与 hover/选中态阴影 |
| `--wd-motion-fast` | hover 与边框反馈动画 |
| `--wd-rating-active` | 评分星级的语义强调色，优先继承主题黄色 |

## 组件约束

- `web-desk-toolbar`：只放视图级短操作，按钮统一使用 `web-desk-tool-btn`。
- `web-desk-icon`：网页收藏；视觉重心是方形缩略图和两行标题。
- `web-desk-rating`：1–5 星评分；可独立或语义绑定网页，链接失效时保留评分并使用 missing 状态。
- `web-desk-image`：Vault 图片附件；拖动主体，右下角手柄等比例缩放。
- `web-desk-textbox`：自由备注；允许非等比例调整。
- `web-desk-group`：归类范围；虚线边框，不承载正文内容。
- `*-resize`：右下角统一缩放手柄；不得各组件自行复制尺寸和边框规则。

## 状态

- hover：只提升边框与阴影，不改变布局。
- selected：使用 Obsidian accent，不新增插件私有主色。
- missing：附件不存在时保留布局并显示占位，不自动删除数据。
- destructive：通过 Obsidian `Menu`/`Modal` 表达；移出图片只删画布引用，不删除附件。
