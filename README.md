<p align="center">
  <img src="docs/assets/logo.png" alt="Orosus" width="480">
</p>

<p align="center">
  <b>简体中文</b> · <a href="README_EN.md">English</a> · <a href="docs/ROADMAP.md">路线图</a> · <a href="docs/developers.md">开发者指南</a>
</p>

<p align="center">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-339933">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-monorepo-f69220">
  <img alt="platform" src="https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-0078d6">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

<p align="center">
  玄墨铺底以为架，青玉点窍以为神，石青叠层峦之形，暖金走灵犀之脉，赭石定磐礡之根。<br>
  群峰连亘而不绝，百脉周流而相通。
</p>

<p align="center">
  <b>Orosus</b> 是一个模块化 AI 编程助手 CLI——TypeScript 编写、Node 22+ 直接运行（无需编译），<br>
  由核心内核、契约包和一组可插拔模块组成，内置模块与外部模块走同一条注册管线。
</p>

---

## 三分钟上手

### 1. 安装

```bash
git clone https://github.com/zhangxyfs/Orosus.git
cd Orosus
pnpm install
```

### 2. 启动

```bash
pnpm orosus
```

首次启动若无可用 provider，会自动进入 `/provider` 向导，按菜单引导完成端点 / 密钥 / 模型配置后自动 reload。

### 3. 日常使用

直接输入自然语言即可对话；`/` 开头是命令（输入 `/` 后按 Tab 补全，`@` 后 Tab 补全文件路径，支持 `@path#L10-L20` 引用行范围，Alt+V 粘贴图片）。

| 分类 | 命令 | 作用 |
|------|------|------|
| 会话 | `/new` `/fork` `/sessions`（`/resume`） `/title`（`/rename`） `/quit` | 新会话 / 分叉 / 恢复历史会话 / 命名 / 退出 |
| 模型与状态 | `/model` `/reload` `/summary` `/help` | 切换模型（回答中也可执行，下一轮生效）/ 重载模块配置 / 查看压缩摘要 / 帮助 |
| 模块命令 | `/compact` `/permission` `/yolo` `/auto` | 手动压缩历史 / 查看或切换审批模式 / 一键全自动批准 / 一键回日常默认档 |
| 信息面板 | `/other` | 磁盘占用 / 上下文用量 / Token 用量 / 运行状态 |

## 特性

- **模块化内核**：核心五件（session / loop / tool / provider / kernel）+ 零依赖契约包 `@orosus/contracts`，模块经拓扑序激活、可热重载、失败降级不阻断启动
- **多厂商支持**：Anthropic / GLM / Kimi / DeepSeek / OpenAI 品牌适配器 + 自定义厂商统一入口（OpenAI 兼容端点）
- **工具生态**：文件系统、Shell、Todo、Ask 等内置工具模块；技能系统与 MCP 桥接
- **审批门**：工具执行两阶段（声明 → 执行），`tool/pre-execute` 瀑布拦截点统一审批；ask-when-needed / yolo / auto 多档模式，手写 deny 规则始终优先
- **上下文管理**：自动 / 手动压缩（compaction 模块），read 窗口化 + 截断去重，多模态图片真实喂图
- **TUI 界面**：全屏接管、流式重绘、键盘菜单 / Esc 取消、Markdown 渲染（框架化进行中，见路线图）
- **数据自治理**：会话 JSONL 可读可 grep；`OROSUS_HOME` 环境变量 + `orosus home migrate` 支持整体迁移缓存目录

## 仓库结构

```
Orosus/
├─ apps/cli/                    # 唯一前端：REPL + 子命令（provider/module/home）
├─ packages/
│  ├─ core/                     # 核心五件 + kernel + 诊断日志 + createHarness 编程式入口
│  ├─ contracts/                # 零依赖契约，按域分包：module / tool / provider / fs / home
│  ├─ testing/                  # 测试基建：fakeProvider / fakeModule 等
│  └─ modules/                  # 内置模块（与外部模块走同一条 kernel 注册管线）
│     ├─ tool-fs/  tool-shell/  tool-todo/  tool-ask/   # 能力模块
│     ├─ skill/  mcp/                                   # 内容系统 / MCP 桥接
│     ├─ approval/  compaction/                         # 审批门 / 上下文压缩
│     └─ provider-{anthropic,glm,kimi,deepseek,openai}/  provider-custom/
└─ tests/                       # 跨包集成测试（模块图/信任门/reload/多 provider 共存等）
```

## 开发

```bash
pnpm test               # vitest 全量测试
pnpm typecheck          # tsc 全仓类型检查
pnpm lint               # oxlint
pnpm check:boundaries   # 包边界检查（核心件不得 import 模块等）
pnpm build              # tsdown 全仓构建
pnpm gen-docs           # typedoc 生成 API 文档（docs/api）
```

| 文档 | 位置 |
|------|------|
| 路线图（之后做什么，单一事实源） | [docs/ROADMAP.md](docs/ROADMAP.md) |
| 模块开发者指南（最小模块示例 / 贡献点 / 拦截点） | [docs/developers.md](docs/developers.md) |
| API 文档（typedoc 生成） | [docs/api/](docs/api/) |

## License

[MIT](LICENSE)
