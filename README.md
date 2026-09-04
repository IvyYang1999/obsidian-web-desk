# Web Desk 网页桌面

An Obsidian plugin that turns your bookmarks into a desktop. Drop a link, an
app or a note onto a free canvas and arrange it the way you arrange icons on
your computer. Every item is a plain Markdown file; positions live in
frontmatter, so the canvas syncs with your vault and nothing is locked in a
database.

在 Obsidian 里把收藏摆成一张桌面。丢一个链接、一个应用或一篇笔记进画布，
像整理电脑桌面一样拖拽归类。每个收藏都是一个 Markdown 文件，布局写在
frontmatter 里，随 vault 同步，没有数据库也没有 sidecar。

## Features

- **Links become Markdown.** Dropping a URL fetches the article (Readability),
  a tweet, or builds a site card from Open Graph metadata, then saves it as a
  note in your bookmark folder.
- **Web pages, local apps and notes on one canvas.** Drag a `.app`, a folder or
  any file from Finder and it becomes a launcher icon with its real system
  icon. Double-click to launch. Drag Markdown or PDF from your vault and it
  becomes a note card.
- **Areas, ratings, arrows and text.** Group things spatially, rate them, or
  annotate the canvas. Areas carry their members when you move them.
- **Zoom that stays readable.** Area names keep a constant on-screen size;
  captions, descriptions and titles drop away as you zoom out, so the small
  view is a navigation view.
- **Canvases inside notes.** A ```` ```web-desk ```` code block renders the same
  canvas inline, with the same capabilities.

## Install

### From the community plugin list

Not yet listed. Until it is, use one of the options below.

### With BRAT (recommended for now)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the
   community plugin list.
2. Run **BRAT: Add a beta plugin for testing** and paste
   `IvyYang1999/obsidian-web-desk`.
3. Enable **Web Desk 网页桌面** in Settings → Community plugins.

BRAT keeps the plugin updated automatically.

### Manually

Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/IvyYang1999/obsidian-web-desk/releases/latest),
put them in `<vault>/.obsidian/plugins/web-desk/`, then enable the plugin.

## Usage

Open the canvas from the ribbon (grid icon) or the command palette
(**Open web desk**). Then:

| Action | Result |
| --- | --- |
| Drop a URL, or paste one | Fetches it and adds a bookmark note |
| Drop a `.app`, folder or file from Finder | Adds a launcher icon |
| Drop Markdown or PDF from the vault | Adds a note card |
| Drag an item into an area | Writes `desk_group` into its frontmatter |
| Double-click | Opens the page, launches the app, or opens the note |
| Scroll / ⌘-scroll | Pan / zoom |

Bookmarks are stored in the folder set in plugin settings (default `收藏夹`).
Local app icons are cached under the attachment folder.

## Development

```bash
npm install
npm run build      # tsc + production bundle
npm run test:unit  # unit tests
```

`scratch/parity-visual-smoke.cjs` drives a real Obsidian instance over CDP and
checks that both canvases keep the same capabilities.

Design constraints live in [DESIGN.md](DESIGN.md).

## License

MIT
