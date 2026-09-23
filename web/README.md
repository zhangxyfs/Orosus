# Orosus 官网（GitHub Pages）

纯静态站点——零构建、零依赖，`index.html` 双击即可本地预览，也可直接作为 GitHub Pages 的发布目录。

## 页面

| 文件 | 内容 |
|---|---|
| `index.html` | 首页：首屏（logo + 连山诗句 + 终端演示窗）、名字由来、特性、架构分层、三分钟上手、连山主题十色板 |
| `tutorial.html` | 模块开发 walkthrough（含 §12 完整 API 参考；同步自 `docs/module-walkthrough.md`） |
| `docs.html` + `docs.css` + `docs.js` | **markdown 查看器**：读 `md/` 镜像 → marked 渲染 → 链接改写（.md 继续走查看器、`docs/api/` 指向站点 /api/、资源指向镜像）。`?file=` 深链 |
| `vendor/marked.min.js` | marked v12 本地化（查看器依赖，离线可用，不走 CDN） |
| `api/`、`md/` | **部署期生成，gitignore 了**：workflow 把 `docs/api`（typedoc）与全仓 markdown（含 docs/assets）拷进来；本地预览需手动构建，见下 |
| `style.css` | 连山主题十色 CSS 变量（与 `apps/cli/src/theme.ts` 同源） |
| `hl.js` | 迷你语法高亮（关键字青玉 / 字符串暖金 / 注释雾灰） |
| `assets/logo.png` | 字标（黑底已透化，首屏主视觉） |
| `assets/logo-icon-color.webp` | 应用图标·彩色版（38KB，favicon + 名字区块；裁自生成原图、水印已除） |
| `assets/logo-icon-mono.webp` | 应用图标·白色线稿版（名字区块副标 + 页脚标记） |
| `assets/logo-icon-color.png` | 图标 PNG 512²（og:image 社交预览用；README 引 docs/assets 同图） |

## 本地预览的镜像构建

`docs.html`（看 markdown）和导航「API」在本地预览前需要一次性拷贝：

```bash
cp -r docs/api web/api
mkdir -p web/md
git ls-files -- 'README.md' 'README_EN.md' 'docs/*.md' 'docs/assets/*' \
  | grep -v '^docs/api/' | xargs -d '\n' cp --parents --target-directory=web/md/
```

（Git Bash 直接可跑；线上由 pages workflow 自动执行同样步骤。）

## 上线（GitHub 免费站点）

1. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
2. 合入 `.github/workflows/pages.yml`（本仓库已带）——之后每次 push master 自动把 `web/` 发布到
   `https://<user>.github.io/<repo>/`。
3. 手动触发：Actions 页选 `pages` workflow → Run workflow。
4. 仓库社交预览卡（推到各处的分享卡片）：**Settings → General → Social preview** 手动上传
   `web/assets/logo-icon-color.png`——这个是仓库设置，文件里配的 og:image 管不了它。

## 修改约定

- 颜色只改 `:root` 变量，别写裸色值（与 theme.ts 十色保持同源）。
- `tutorial.html` 是 `docs/module-walkthrough.md` 的手工转写——**改动教程内容先改 markdown 源**
  （单一事实源），再同步到本页（含 §12 API 参考）；代码块记得转义 `<` `>` `&`。
- 改完 markdown 记得同步 `web/md/` 镜像（本地预览才看得到新内容）——重新跑上面的拷贝命令即可。
- `docs.html` 的侧栏文件清单是手写的——新增需要展示的 md 时同步补一行。
