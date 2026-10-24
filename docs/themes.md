# 主题开发

主题是纯 Liquid 模板包，**不执行服务端 JavaScript**。它只接管自己提供了模板的页面：没提供模板的页面继续用站点内置渲染，渲染抛错也会自动回退，所以主题写坏了不会白屏。

## 目录结构

```
themes/<id>/
├── theme.json            必需，清单
├── screenshot.png        可选，后台卡片预览（≤ 2MB）
├── templates/            必需
│   ├── layout.liquid     可选；没有它只替换正文，外壳仍用内置
│   ├── head.liquid       可选；片段自动插入站点 <head>
│   ├── home.liquid
│   ├── posts.liquid
│   └── partials/card.liquid
└── assets/               可选；纯模板主题可以完全没有这个目录
    ├── theme.css         自动注入到 </head> 前
    └── theme.js          不会自动注入，见「资源」
```

`theme.json` 的 `templates` / `assets` 可以改名，但必须是主题目录内的相对路径。

## theme.json

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 小写字母、数字、短横线，以字母或数字开头、≤ 48 字符，**必须与目录名一致** |
| `name` | 是 | 后台显示名，≤ 80 字 |
| `version` | 否 | 语义化版本，默认 `0.0.0` |
| `engine` | 否 | 面向的主题 API 版本，只比对主版本号。当前为 `1` |
| `author` / `description` | 否 | 后台展示用 |
| `default` | 否 | `true` 表示没有激活主题时优先用它 |
| `screenshot` | 否 | 相对路径，默认根目录 `screenshot.png` |
| `templates` / `assets` | 否 | 目录名，默认 `templates` / `assets` |
| `options` | 否 | 设置项数组，见「设置项」 |

## 模板层级

模板名 = `templates/` 下相对路径去掉扩展名（`.liquid` / `.html`）。按顺序找，第一个命中的生效。同名文件同时存在时 `.liquid` 优先。`{% render %}` 的省略扩展名写法只会补 `.liquid`；引用 `.html` 分部模板时要写全扩展名（如 `{% render 'templates/partials/card.html' %}`）。

| `page.type` | 查找顺序 |
| --- | --- |
| `home` | `home` → `front-page` → `index` |
| `posts` | `posts` → `home` → `list` → `index` |
| `notes` | `notes` → `list` → `index` |
| `post` | `post-<slug>` → `single-post` → `single` → `index` |
| `note` | `note-<slug>` → `single-note` → `single` → `index` |
| `page` | `page-<slug>` → `page` → `index` |
| `archive` | `archive` → `index` |
| `archive-year` | `archive-year` → `archive` → `index` |
| `search` | `search` → `index` |
| `friends` | `friends` → `index` |
| `links` | `links` → `index` |
| `404` | `404` → `not-found` → `index` |
| `go` | `go` → `404` → `index` |

`<slug>` 会先经过文件名安全化：非字母/数字/下划线/短横线的字符替换为 `-`，去掉首尾 `-`，最多 80 个字符。例如 slug 为 `C++` 时对应 `post-C.liquid`（不是 `post-C++.liquid`）；中文 slug 原样保留。

两个容易踩的点：

- **`page.type` 才是主题类型**，`page.page` 是内置页面标识（`home` / `list` / `notes` / `page` / `archive` / `search` …），判断页面请用 `page.type`。
- **子模板路径相对主题根目录**。`templates/partials/card.liquid` 的模板名是 `partials/card`，但引用时要写全：

```liquid
{% render 'templates/partials/card', post: data.posts[0] %}
```

## 上下文

### 全站与页面

| 变量 | 内容 |
| --- | --- |
| `site` | `title` `identity` `desc` `author` `url` `domain` `lang` `mark` `icp` `year` |
| `page` | `type` `page` `active` `title` `desc` `canonical` `url` `noindex` `lang` `ogType` |
| `meta` | `title` `full_title` `desc` `canonical` `og_type` `og_image` `og_locale` `noindex` `extra_head` `json_ld` |
| `nav` | `current` 与 `items[]`（每项 `href` `label` `key` `active`） |
| `theme` | `id` `name` `version` `author` `description` `api` `options` `asset_base` |
| `options` | 当前设置值（已与默认值合并） |
| `content` / `main` | 页面模板里是内置正文；`layout` 里是子模板渲染结果（没有页面模板时退回内置正文）。输出必须 `\| raw` |
| `chrome` | 站点外壳片段，见下 |

`meta.extra_head` 是原始 HTML 字符串，输出必须 `| raw`；`meta.json_ld` 是结构化数据数组，自己输出时写 `{{ meta.json_ld | json | raw }}`（通常 `chrome.head` 已经带上了）。

### 各页面的 `data`

| `page.type` | `data` 字段 |
| --- | --- |
| `home` | `hero_html` `hero{}`（`images[]`：`path` `w` `h`）`stats[]`（每项 `kind` `n` `words` `first` `last`）`recent[]` `has_recent` |
| `posts` | `kind` `title` `mark` `posts[]` `has_more` `more_html` `masthead_html` `list_html` `empty` |
| `notes` | `kind` `title` `mark` `notes[]` `has_more` `more_html` `masthead_html` `stream_html` `empty`（**列表在 `data.notes`，不是 `posts`**） |
| `post` / `note` | `post{...}` `toc_html` `pager_html` `comments_html` `body_html` `words` `reading_minutes` `day_cn` |
| `page` | `page{...}` `comments_html` `stats[]`（已渲染的 HTML 片段）`page_html` |
| `archive` | `archive_html` |
| `archive-year` | `year` `posts[]` `year_html` `empty` |
| `search` | `q` `result` `counts`（`{ 文章 id: 评论数 }`）`search_html` |
| `friends` | `friends_html` `items` `sources` `recent_count` `next_href` |
| `links` | `links_html` `links[]`（每项 `name` `host` `url` `avatar` `comments` `last_seen` `site_title`）`total` `pages` `page` `recent_comments` |
| `404` | `recent[]` `not_found_html` |
| `go` | `name` `go_html` |

列表项（`posts[]` / `recent[]` / `notes[]`）的字段：`id` `slug` `kind` `title` `url` `datetime` `date` `date_cn` `relative` `excerpt` `comments`（已通过审核的评论数）`draft` `lang`。单篇文章的 `data.post` / `data.page` 同样带这些字段。

`data` 里那些 `*_html` 字段是内置渲染好的片段，可以直接 `| raw` 输出，也可以完全不用、自己用数组重排。

兼容别名：`post` / `page` 模板里的 `data.post`、`data.page` 也带有 `body_html`、`toc_html`、`pager_html`、`comments_html`（与顶层同值），旧主题可继续从对象上取；`notes` 页面额外提供 `data.posts` 作为 `data.notes` 的别名。

### `chrome`

`chrome` 是站点外壳。**全部是 HTML 字符串，输出必须 `| raw`**：

| 片段 | 作用 | 不输出会怎样 |
| --- | --- | --- |
| `chrome.head` | 完整 `<head>`：字符集、标题、canonical、OG、样式表、主题引导脚本 | SEO、分享卡、暗色/配色首帧全丢 |
| `chrome.scripts` | `request/ui/nav/search/app` 五个脚本 | 评论、灯箱、检索展开、代码复制全失效 |
| `chrome.lightbox` | 图片灯箱容器 | 点图片放大失效 |
| `chrome.emoji` | 表情面板模板（仅相关页面有内容） | 评论区表情键点了没反应 |
| `chrome.header` | 站点页头与导航 | 只剩正文 |
| `chrome.drawer` | 窄屏目录抽屉 | 手机上打不开菜单 |
| `chrome.footer` | 页脚（版权、RSS、配色选择器） | 访客不能切换明暗与配色 |
| `chrome.skip` `chrome.progress` `chrome.top` `chrome.toTop` | 跳到正文、阅读进度、锚点、回到顶部 | 可访问性与交互降级 |

`chrome.htmlAttrs` 输出 `data-palette=…`，挂在 `<html>` 上（值已白名单校验、不含引号，直接写 `{{ chrome.htmlAttrs }}` 即可）；`chrome.lang` 是站点语言。顶层 `nav` 由站点根据当前页面自动生成，不需要路由或主题自己拼；`data.nav` 只作为覆盖入口保留。

### `templates/head.liquid`

主题可选片段，渲染结果通过 `theme_head` 自动插到 `</head>` 前，适合加字体、预加载、验证标签等。它和页面模板拿到同一份上下文，但不要在这里输出整段 HTML——站点已经有 `chrome.head`。

没有 `layout.liquid` 的主题同样会自动带上 `theme.css` 和 `head.liquid`：引擎把这两段交给内置外壳注入，不必自己拼 `<head>`。

### 必须保留的结构

内置脚本依赖两个节点，主题布局请原样保留：

```liquid
<div id="app">            <!-- pjax 只替换这个节点，缺了它换页会整页刷新 -->
  <main id="main" tabindex="-1">   <!-- 跳过链接的落点、换页后的焦点目标 -->
```

## 资源

| 用法 | 说明 |
| --- | --- |
| `{{ 'logo.png' \| asset }}` | 生成 `/theme-assets/<id>/logo.png?v=<指纹>`；文件不存在时返回空串 |
| `{{ theme_css }}` | `assets/theme.css` 的地址，已自动注入 `</head>` 前，通常不用手写 |
| `{{ theme_js_tag \| raw }}` | `assets/theme.js` 的 `<script defer>` 标签，文件不存在时为空串；放在 body 末尾即可 |
| `{{ theme_js }}` | 只要地址（需要自己控制 `defer` / `type`）时用它，同样不会自动注入 |
| `theme.asset_base` | `/theme-assets/<id>/`，需要自己拼路径时用 |

`asset` 过滤器只认 `assets/` 下的文件和截图，越界路径返回空串。资源地址按路径分段编码，文件名里有空格或 `?` 也能正确取到。

### 内置过滤器

| 过滤器 | 说明 |
| --- | --- |
| `asset` / `theme_asset` | 主题资源地址（同上） |
| `abs_url` | 站内路径转绝对地址：`{{ '/posts/' \| abs_url }}` |
| `json` | `JSON.stringify`（`<` 写成 `\u003c`）。默认自动转义会破坏引号，输出到 `<script>` 时写成 `{{ value \| json \| raw }}` |
| `strip_html` | 去标签并压空白，得到纯文本 |
| `excerpt` | 去标签后截断，长度默认 120：`{{ post.body_html \| excerpt: 80 }}` |

## 设置项

`theme.json` 的 `options` 是一个数组（≤ 40 项），每项 `key`（小写字母开头，后接字母/数字/下划线，≤ 32 字符）、`type`、`label`（≤ 60 字），可选 `description`（≤ 200 字）、`default`：

| `type` | 表单控件 | 额外字段 |
| --- | --- | --- |
| `text` | 单行输入 | — |
| `textarea` | 多行输入（≤ 2000 字） | — |
| `color` | 文本框 + 取色器 | 只接受 `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`；清空保存表示恢复该项默认值 |
| `boolean` | 复选框 | — |
| `select` | 下拉 | `options: [{ value, label }]`；`default` 不在选项里时回退到第一项 |
| `number` | 数字输入 | `min` `max` `step`，越界会被拒绝 |
| `image` | 文本框 + 媒体库选择 | 只接受站内路径（`/` 开头，不含空白/引号/`?`/`#`）；外站图片会被 CSP 的 `img-src` 拦掉，保存时直接拒绝 |

模板里用 `{{ options.accent }}` 读取。保存时服务端会再校验一遍：非法值整份拒绝，不会写进库。

主题升级后删掉的旧 key 会留在库里但不参与渲染；新加的 key 自动取 `default`，不需要写迁移。

## 安全边界

- 安装主题等同于**信任主题作者**：`assets/theme.js` 是同源脚本，能读取同源页面并以站主身份请求后台接口。CSP 只限制内联脚本，不是主题沙箱；不要安装来路不明的主题。
- 模板默认**自动转义**。输出 HTML 必须显式 `| raw`——这是第三方主题最容易出 XSS 的地方，默认安全优先。
- 模板跑在 Liquid 沙箱里，拿不到 `require`、`fs`、`process`。
- CSP 由站点统一发：`script-src 'self'` + 两段固定哈希。**主题里的内联 `<script>` 会被浏览器拦掉**；需要脚本就放 `assets/theme.js`，用同源外链引入。
- `style-src` 允许 `'unsafe-inline'`，所以内联 `<style>` 与 `style="…"` 可用。
- `img-src 'self' data:`，**外站图片会被拦**，图片请放进 `assets/` 或用站内媒体库。
- 上传的 ZIP 会校验：根目录（或唯一一级目录）必须有 `theme.json`；≤ 10MB、≤ 300 个文件、单文件解压后 ≤ 5MB、总计 ≤ 20MB；拒绝软链接和 `../` 路径。
- 手动拷进 `themes/` 的目录会额外校验真实路径：`assets/` 或截图即使是指向主题目录之外的软链接，也不会被 `/theme-assets/` 读取。

## 安装、预览与删除

- **安装**：后台「外观 → 安装主题」上传 ZIP，或直接把目录放进 `themes/<id>/`。启用前会解析全部模板，有语法错误不允许启用。
- **启用**：`theme_active` 指向主题 id。使用中的主题不能删，且站点至少保留一个主题。
- **预览**：外观页点「预览」下发 10 分钟 cookie，只对已登录站主生效，访客不受影响。预览期间前台底部有一条提示条，点「退出预览」立刻结束，不必等 cookie 过期。
- **删除**：目录移进 `themes/.trash`，不会立刻销毁。超过 `TRASH_KEEP_DAYS`（默认 90 天）后由启动清理与 `npm run cleanup:trash` 回收；回收站不进备份。
- **备份**：`themes/` 整个目录随完整备份归档（`.trash` 除外）。

## 调试

- 清单/目录校验失败：后台外观页底部「未加载的主题」会列出目录与具体原因（缺 `theme.json`、id 与目录名不一致、模板目录缺失等）。模板语法错误不在这里，点「启用」时会被逐文件解析并给出文件名，改好后重新启用即可。
- 运行时渲染失败：自动回退内置外壳，并在后台外观页「最近的主题渲染失败」里列出主题、模板、时间与连续次数（内存缓冲最多 20 条，页面展示最近 5 条，可一键清空）。前台看不出异常，这里才看得到。
- 本地开发时 `NODE_ENV` 不是 `production`，模板不做解析缓存，改完刷新即可。
- 主题设置保存在 `settings` 表的 `theme_options:<id>`，值是 JSON。

## 从一个能跑的骨架开始

`scripts/fixtures/fixture/` 是一个覆盖全部模板层级（含 `friends` / `links` / `go`）的测试主题，可以直接复制出来改名当起点：

```sh
cp -r scripts/fixtures/fixture themes/my-theme
# 改 theme.json 的 id / name（id 必须等于目录名）
```

它同时是 `npm test -- --only test-themes` 的夹具，改动它会连带验证模板层级、设置项、上传安装、预览与备份。
