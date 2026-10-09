# Orosus（连山）项目架构与技术说明

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 技术栈](#2-技术栈)
- [3. 模块架构](#3-模块架构)
- [4. 目录结构](#4-目录结构)
- [5. 核心组件详解](#5-核心组件详解)
- [6. 核心业务架构](#6-核心业务架构)
- [7. 数据流与事件流](#7-数据流与事件流)
- [8. 模块扩展系统](#8-模块扩展系统)
- [9. 审批系统（approval）](#9-审批系统approval)
- [10. 上下文压缩（compaction）](#10-上下文压缩compaction)
- [11. 技能系统（skill）](#11-技能系统skill)
- [12. 子代理系统（tool-subagent）](#12-子代理系统tool-subagent)
- [13. 性能优化策略](#13-性能优化策略)
- [14. 依赖关系图](#14-依赖关系图)
- [15. 构建配置与命令](#15-构建配置与命令)
- [16. 测试与验证](#16-测试与验证)
- [17. UI 双模式详解](#17-ui-双模式详解)
- [18. 常见问题排查](#18-常见问题排查)
- [19. 后续维护建议](#19-后续维护建议)

---

## 1. 项目概述

**Orosus**（中文定名「连山」）是一个模块化 AI 编程助手 CLI——TypeScript 编写、Node 22+ 直接运行（`--experimental-strip-types`，无需编译），由核心内核、契约包和一组可插拔模块组成，内置模块与外部模块走同一条注册管线。2026-10-07/08 经 `release/` 聚合包发布 `orosus`@0.1.0 与 0.1.1 上 npm（tsdown 三入口构建 + 装机冒烟真发）。

| 功能 | 说明 |
|------|------|
| **多厂商模型接入** | openai / anthropic 两族 wire 协议翻译层，TOML 配置自定义 provider，models.dev 目录自动发现 + contextWindow 兜底链 |
| **工具系统** | 31 个产品级一方工具 + MCP 动态桥接（`mcp__<server>__<tool>`），两阶段执行 + Access 权限声明 + 审批漏斗 |
| **审批安全** | 三档模式（Always Ask / Ask When Needed / Never Ask），tree-sitter-bash AST 危险命令判定 |
| **上下文压缩** | 阈值自动压缩 + 溢出救援 + 手动 /compact，六小节结构化摘要，v4 自包含载荷 |
| **会话管理** | append-only JSONL/SQLite 持久化，项目分桶，fork 分叉 + 会话树 + 事件索引三层装载 |
| **子代理** | 独立上下文子代理（并发 8 / 100 轮 / 双保险丝），写协调闸防冲突 |
| **技能系统** | 五轨目录扫描 SKILL.md，按需加载全文，11 件出厂技能 |
| **MCP 接入** | stdio / streamable HTTP 双 transport，工具桥接进统一注册表 |
| **多媒体** | 图片读取/裁剪/降采样/转换 + 眼睛模型旁路转述 + ffmpeg 视频抽帧 |
| **多语言** | 内建三语（en-US / zh-CN / zh-TW）+ multilang 语言包挂载至六语（+ja/ko/ru） |
| **会话互相感知** | tool-peers 共享记忆（git 根分桶）+ 会话登记/认领/释放 + 记忆导入 |
| **生命周期钩子** | hooks 七事件（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop / PermissionRequest），Claude Code 兼容协议 |
| **双模式 TUI** | 行模式 REPL / 全屏 alt-screen TUI（自绘 markdown、鼠标滚轮、弹窗系统） |

**根项目名**: `orosus`（package.json version 0.1.1，private）
**运行方式**: `pnpm orosus` → `node --experimental-strip-types apps/cli/src/main.ts`
**发布形态**: `npx orosus`（npm 包 `orosus` 0.1.1，bin `dist/main.js`，files = dist + bundled + assets）

---

## 2. 技术栈

### 2.1 核心技术栈

| 类别 | 技术/版本 |
|------|-----------|
| 语言 | **TypeScript** ^5.6.0（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + verbatimModuleSyntax） |
| 运行时 | **Node.js ≥ 22**（type: module，ESM，直跑 .ts 不构建） |
| 包管理 | **pnpm** workspace（lockfileVersion 9.0） |
| 发布构建 | **tsdown** ^0.9.0（`apps/cli/tsdown.config.ts` 三入口：main + imaging-worker + media-worker） |
| 模块解析 | NodeNext / moduleResolution NodeNext，target ES2023 |
| 测试 | **Vitest** ^2.1.0（node 环境，单配置全仓） |
| Lint | **oxlint** ^1.0.0 |
| 类型检查 | tsc --noEmit（根 + 各包独立 typecheck） |
| 文档生成 | 自研 gen-api-docs / gen-extension-catalog 脚本（docs:check 守门） |

### 2.2 依赖版本清单（dependencies，全部来自各 package.json 实读）

| 依赖 | 版本 | 用途 | 消费包 |
|------|------|------|--------|
| zod | ^4.0.0 | schema 校验（契约/工具参数/配置） | 全部 23 个 workspace 包 |
| jiti | ^2.7.0 | 外部模块 TS 直载（alias 钉 contracts） | core |
| smol-toml | ^1.3.0 | TOML 解析（配置读写） | core / cli / approval / provider-custom / tool-web |
| @modelcontextprotocol/sdk | ^1.12.0 | MCP 客户端 | mcp |
| cli-highlight | ^2.1.11 | 代码高亮（hljs 封装） | cli |
| marked | ^16.4.2 | markdown 词法解析（全仓唯一进口） | cli |
| turndown | ^7.2.0 | HTML → markdown | tool-web |
| turndown-plugin-gfm | ^1.0.2 | GFM 表格支持 | tool-web |
| @jsquash/webp | ^1.5.0 | WebP 编解码（图片 worker） | tool-media |
| jimp | ^1.6.1 | 约束目标尺寸（图片 worker） | tool-media |
| @types/node | ^22.10.0 | 类型 | 根（devDependencies） |
| typescript / vitest / oxlint | ^5.6.0 / ^2.1.0 / ^1.0.0 | 工具链 | 根（devDependencies） |

**依赖态度**（2026-09-30 九仓调研结论）：Orosus 外部依赖量级为全场最少档——只为「纯 JS 做不了的硬活」引依赖；带第三方 dependencies 的仅 core / mcp / cli / tool-web / tool-media 五家（外加发布聚合包 release），其余模块包零外部依赖。

**发布依赖闭环**（release-lib.mts `collectBundledPackages`）：入口包（cli）收 deps + devDeps，再沿 dependencies 递归——core 的 jiti/smol-toml、tool-web 的 turndown 系、tool-media 的 jimp/@jsquash/webp 经此链全部收进 `release/` 的 dependencies（workspace 内部 `workspace:*` 不进产物依赖）；主版本冲突 throw（widenVersion）。

**workspace 内部依赖**（`workspace:*` 协议）：详见 [第 14 章 依赖关系图](#14-依赖关系图)。

### 2.3 边界纪律（scripts/check-boundaries.mts 强制）

- `@orosus/contracts`：标记 `"orosus": { "contract": true }`，依赖只能是 zod；
- 各功能模块包：dependencies 只能有 `@orosus/contracts`（+自身外部依赖），**不得 import core / 不得互相 import**；
- 违反即 CI 红灯（`pnpm check:boundaries`）。

---

## 3. 模块架构

```
                    ┌─────────────────────────────┐
                    │        apps/cli（宿主）        │
                    │  main.ts 1995 行 + tui/ + md/ │
                    │  145 源文件 26759 行           │
                    └──────────────┬──────────────┘
                                   │ import + 装配
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼────────┐        ┌────────▼────────┐        ┌────────▼────────┐
│ @orosus/core   │        │ @orosus/contracts│        │ @orosus/testing │
│ 内核：harness/  │        │ 契约：module/tool│        │ 测试基建：       │
│ kernel/loop/   │────────│ provider/fs/home│        │ fakeProvider/   │
│ session/subagent│       │ /version         │        │ fakeModule      │
└────────────────┘        └─────────────────┘        └─────────────────┘
        ▲                                                    ▲
        │ 装配时注入（宿主经 builtins.ts 收 18 个内置模块）      │
┌───────┴────────────────────────────────────────────────────┴──────────┐
│                     packages/modules/（18 个模块包）                     │
│  工具组：tool-fs / tool-shell / tool-web / tool-ask /                    │
│         tool-goal / tool-search / tool-todo / tool-subagent /            │
│         tool-media / tool-peers                                          │
│  系统组：approval / compaction / mcp / provider-custom /                 │
│         session-tree / skill / multilang / hooks                         │
│  全部只依赖 @orosus/contracts（边界检查强制）                              │
└─────────────────────────────────────────────────────────────────────────┘
```

**依赖关系**（workspace 内部，实读各 package.json）:

- `@orosus/contracts` → （无）
- `@orosus/core` → contracts、testing
- `@orosus/testing` → contracts
- `@orosus/i18n` → contracts（三源文件：floor.ts / runtime.ts / index.ts，多语言运行时基建）
- `@orosus/cli` → core、contracts + 全部 18 个模块包（devDependencies 同款）
- 各模块包 → contracts（tool-* 另加 testing 为 devDependencies；tool-shell 加 tool-fs；mcp 加 core+testing+tool-search；session-tree 加 core+testing；tool-subagent 加 approval + core + testing）

**分层铁律**：模块只认契约不认内核（core/src/index.ts:1 注）；CLI 与 tests/ 是 core 的消费者；compaction 的投影逻辑与 core 的 deriveMessages 是「铁律 2 双写」（两侧测试钉一致）。

**18 个内置模块**（`apps/cli/src/builtins.ts`，BUILTIN_MODULES 数组）：toolFs / toolShell / toolTodo / toolAsk / toolWeb / toolSearch / toolGoal / sessionTree / providerCustom / mcpDef / skill / multilang / approval / compaction / hooks / toolSubagent / toolMedia / toolPeers。品牌 provider（anthropic / glm / kimi / deepseek）与 openai 模块已于 2026-09-23 拍板退役，路线归一为 provider-custom + models.dev 目录 + 双协议族翻译层。

## 4. 目录结构

```
Orosus/
├── package.json                 # 根 0.1.1（private）：scripts 四门 + release 脚本
├── pnpm-workspace.yaml          # packages/* + packages/modules/* + apps/* + release
├── tsconfig.base.json           # strict 全开基线，各包 extends
├── vitest.config.ts             # 单配置全仓测试
├── scripts/                     # 11 文件：check-boundaries / gen-api-docs /
│                               # gen-extension-catalog / release.mts / release-lib.mts ...
├── release/                     # ★ npm 聚合包 orosus（0.1.1）——tsdown 产物落 dist/
├── apps/
│   └── cli/                     # ★ 命令行宿主（145 源文件 26759 行）
│       ├── tsdown.config.ts     # 发布构建：main + imaging-worker + media-worker
│       └── src/
│           ├── main.ts          # 入口：子命令→装配→REPL/TUI 双循环（1995 行）
│           ├── builtins.ts      # BUILTIN_MODULES：18 个内置模块清单
│           ├── args.ts          # CLI 旗标解析
│           ├── sessions.ts      # /sessions /fork /title 会话拦截层
│           ├── atfile.ts        # @path / @path#L10-L20 文件引用
│           ├── paste.ts / altpaste.ts  # 剪贴板图片（Alt+V）
│           ├── render.ts        # 双订阅渲染编排（liveChunks + events）
│           ├── theme.ts         # 连山主题色板
│           ├── provider-cmd.ts / home-cmd.ts / module-cmd.ts / prune.ts  # 子命令
│           ├── menu.ts / keys.ts / picker.ts  # readline UI / raw 按键基座
│           ├── settings-ui.ts / hooks-ui.ts / tasks-cmd.ts  # 设置/钩子/任务面
│           ├── mcp-cmd.ts / mcp-add-window.ts  # MCP 管理命令与添加窗
│           ├── btw-cmd.ts / at-menu-entries.ts  # /btw 侧问 / @ 菜单
│           ├── tui/             # ★ 全屏渲染层（26 文件 8382 行）
│           │   ├── fullapp.ts   # FullApp 主体（549 行，m5-split 拆分后）
│           │   ├── fullapp-keys.ts (-dialogs/-frame/-input/-menu/-mouse/
│           │   │   -overlay/-panels/-select/-types)  # 拆分件 9 族
│           │   ├── docmodel.ts  # 文档模型：双层滑窗/账本/缓存（1112 行）
│           │   ├── width.ts     # 全仓唯一计宽/折行权威（424 行）
│           │   ├── onboarding.ts / widgets.ts / toolview.ts / popuplayout.ts ...
│           └── md/              # ★ 自绘 markdown 渲染（9 文件 2311 行）
│               ├── lex.ts       # marked 唯一进口
│               ├── latex.ts     # LaTeX → Unicode 线性化（962 行）
│               └── streaming.ts # 稳定前缀冻结流式渲染
├── packages/
│   ├── contracts/               # ★ 契约包（6 文件 1511 行）
│   │   └── src/{module,tool,provider,fs,home}/index.ts + version.ts
│   ├── core/                    # ★ 内核（37 文件 8395 行）
│   │   └── src/
│   │       ├── harness.ts       # createHarness 装配（1654 行）
│   │       ├── index.ts         # 公开出口
│   │       ├── config/          # 分层配置加载/校验/行级写
│   │       ├── diag/            # 诊断日志（按日 jsonl 旁路）
│   │       ├── kernel/          # 模块内核：发现→校验→拓扑→激活→reload
│   │       ├── loop/            # agentLoop + deriveMessages 投影
│   │       ├── provider/        # parseModel 模型路由
│   │       ├── session/         # JSONL/SQLite 存储 + fork + 树索引 + 事件索引
│   │       ├── subagent/        # 子代理 runner + 常量
│   │       └── tools/           # ToolRegistry + 调度 + 输出截断
│   ├── i18n/                    # ★ 多语言运行时（floor.ts / runtime.ts）
│   ├── testing/                 # 测试基建（fakeProvider / fakeModule）
│   └── modules/                 # ★ 18 个模块包（见第 3 章分组）
│       ├── tool-fs 724 行 / tool-shell 760 行 / tool-web 1123 行
│       ├── tool-ask 94 / tool-goal 268 / tool-search 136 / tool-todo 76
│       ├── tool-media 1016 / tool-peers 1432 / tool-subagent 483
│       ├── approval 5976 / compaction 586 / skill 349 / mcp 1809
│       ├── provider-custom 2364 / session-tree 157 / multilang 4525 / hooks 862
│       └── （行数 = src/ 下非 test .ts 合计；各包另有 test 文件）
├── tests/                       # 36 个跨包集成测试
├── web/                         # 官网（纯静态 + Pages workflow，gitignored 运行时镜像）
└── doc/                         # 代码审查报告归档（十三族编号）
```

## 5. 核心组件详解

### 5.1 packages/contracts — 契约包（6 文件 1511 行）

| 文件 | 行数 | 内容 |
|------|------|------|
| module/index.ts | 1113 | ModuleDefinition / ModuleContext / Contributes / 服务、菜单、命令、钩子声明面 |
| provider/index.ts | 165 | Provider 协议 + Chunk 类型 + parseModelsResponse |
| tool/index.ts | 158 | defineTool / Access / resolveExecution 两阶段契约 |
| version.ts | 31 | MODULE_API_VERSION / CONTRACT_API_VERSION |
| fs/index.ts | 25 | Fs 服务接口（LocalFs） |
| home/index.ts | 19 | OrosusHome 路径解析 |

### 5.2 packages/core — 内核（37 文件 8395 行）

| 文件 | 行号锚点 | 职责 |
|------|---------|------|
| harness.ts | createHarness :292 / COMMAND_ALIASES :857 / driveTurn :1153 / prompt :1219 / usage 锚点 :454 / Channel :194 / LiveChannel :244 / EVENTS_CHANNEL_CAP :191 / 装配 :419-:423 | 全装配：装配 harness、命令路由、逐轮驱动、事件面 |
| loop/loop.ts | agentLoop :120 | for-await 分派 chunk；requestSig 缓存失效 :167 |
| kernel/bus.ts | CORE_POINTS :5 起 | 事件总线（十一拦截点 + session/start） |
| kernel/{discover,topo,activate,load,trust}.ts | discover :161 / topo :24 / activate :160 / load :97 / trust :68 | 模块生命周期各阶段 |
| loop/convert.ts | deriveMessages :58 | 条目→ModelMessage 投影（铁律 2 双写另一半） |
| tools/registry.ts | createToolRegistry :62 | 工具注册表；OUTPUT_LIMIT 32768 / HEAD_KEEP 24576 / TAIL_KEEP 8192 |
| tools/schedule.ts | accessConflict :24 / scheduleByAccesses :41 | Access 贪心分组调度 |
| subagent/{runner,constants}.ts | runner :275 | 并发 8 / 轮 100 / 上限 200 / 双保险丝 600s+7200s |
| session/ | — | JSONL/SQLite 存储 + fork + 树索引 + 事件索引（见 §6.3） |

### 5.3 apps/cli/src/main.ts — 入口（1995 行）

| 锚点 | 职责 |
|------|------|
| exitCli :120 | 退出收口 |
| chooseExFace :282 | chooseEx 全屏/行模式双 UI 面 |
| importWithOrganize :472 | peers 记忆导入（含覆盖语义） |
| attachRender :731 | 双订阅渲染编排挂接 |
| processReplLine :843 | 行模式逐行处理（斜杠命令/消息/队列） |
| runFullScreen :1313 | 全屏 TUI 主循环 |
| onboardingInitial :1907 | 首次引导初始化 |

### 5.4 CLI 顶层功能件（apps/cli/src/，除 main.ts 外非 test 文件）

| 文件 | 行数 | 职责 |
|------|------|------|
| tasks-cmd.ts | 489 | /tasks 子代理任务名册（全屏查看窗） |
| hooks-ui.ts | 421 | 钩子设置面（七事件 + 信任审查） |
| settings-ui.ts | 378 | /settings 七项面板 |
| keys.ts | 375 | raw 按键基座 |
| mcp-add-window.ts | 364 | Alt+N MCP 添加窗（手动/JSON 双式） |
| mcp-cmd.ts | 330 | /settings 内 MCP 管理面 |
| picker.ts | 294 | readline 列表选择器 |
| render.ts | 297 | 双订阅渲染编排（liveChunks + events） |
| menu.ts / at-menu-entries.ts | — | 斜杠菜单 / @ 菜单条目 |
| atfile.ts | — | @path / @path#L10-L20 引用（最多 5 个、单文件 50KB） |
| paste.ts / altpaste.ts | — | 三平台剪贴板取图（PowerShell/osascript/xclip）；vision 预检 |
| theme.ts | — | 连山色板 + truecolor→256 降级 |
| ansi-guard.ts | — | stripDangerEsc 危险转义净化（防 OSC 52 偷剪贴板） |
| sessions.ts | — | 会话列表（前 10 倒序、桶闸、/title 旁路写） |
| module-diagnostics.ts | — | Ctrl+E 诊断弹窗（两日窗口事件聚合） |
| modpreset.ts | — | 极简/完整预设三态现算；锁定 orosus-core/approval/活跃 provider |
| help.ts | — | Tab 补全三职（命令 / @文件 / 模块参数委托） |

### 5.5 apps/cli/src/tui/ — 全屏渲染层（26 文件 8382 行）

#### fullapp.ts（549 行）— FullApp 全屏主体（拆分后）

- 组合 Term（终端接管）+ FullScreen（alt-screen 行级 diff）+ FrameScheduler（16ms 合帧，MIN_RENDER_INTERVAL_MS=16）+ AppState 单一状态对象 + FullAppIO（宿主回调缝）；
- m5-split-fullapp 批（2026-10-02）将原 2899 行主体拆成 9 族拆分件：fullapp-keys（723）/ -overlay（471）/ -mouse（360）/ -dialogs（349）/ -input（307）/ -panels（290）/ -frame（282）/ -select / -types（501，含 SIDEBAR_SWITCH_COOLDOWN_MS=500）；
- 布局：左栏 = 流区 + 队列区 + 输入框（INPUT_MAX_ROWS=5）；右栏 = 运行状态面板 + 任务清单；侧栏 cols≥100 时展开；
- 弹窗系统（pendingUi 单槽 + uiQueue FIFO 排队）：pick（含 chooseEx 多选）/ ask / view / dialog + 独立通道：诊断（Ctrl+E）、斜杠菜单、引导弹窗；
- 鼠标：SGR+X10 双协议；滚轮窗口栈路由；左键三击选行/双击选词/拖选+自动滚；滚动条轨道点按/拖动；
- 崩溃恢复：installCrashHooks——process exit 同步写 CRASH_RESTORE，uncaughtException 先恢复终端再抛。

#### docmodel.ts（1112 行）— 文档模型：双层滑窗

- **轮次层 trimTurns**（:572）：`OROSUS_TUI_MAX_TURNS ?? 15`，滞回 HYST=5（`curTurn + 1 <= keep + 5` 不裁）；被裁段与视口相交则整批顺延（阅读保护）；被裁轮整块销毁后 unshift 折叠条目；resume 即裁（:644）。
- **步级层 KEEP_STEPS**（:64-67）：`OROSUS_TUI_KEEP_STEPS ?? 30`，活轮滞回 SLACK=10（收轮终态=精确 30）；触发点 :301-304（轮内工具步折叠）。
- 条目级 LineCache（宽度级缓存键）+ 条目行数账本 + frameWindow(start, maxLines) 尾部累加窗口化；evictFarCaches 远区缓存淘汰（距视口 >3 轮，1Hz 节流）。

#### 其余组件

| 文件 | 职责 |
|------|------|
| width.ts（424 行） | **全仓唯一计宽/折行权威**：visibleWidth/wrapText/graphemeSpans/osc8LinkAtColumn；emoji 散点宽度账本（BMP 实画 2 列纠偏） |
| terminal.ts | raw mode + bracketed paste + 序列切分（X10 鼠标 6 字节原子；孤 ESC 30ms 窗口） |
| fullscreen.ts | alt-screen 行级 diff + ?2026 同步输出；tmux/screen 降级鼠标档；conhost 底行右角不写满 |
| scheduler.ts | 16ms 节流 + 键盘 nextTick 抢占 |
| onboarding.ts | 三页定高首次引导（922 行） |
| widgets.ts / toolview.ts | 只读控件渲染 / 工具明细 diff 行 |
| streamview.ts / live-wrap.ts / diffscreen.ts / keymatch.ts | 流区视图 / 实时行折行 / 差屏 / 键序列匹配（KEY_TABLE 含 Ctrl+O） |

### 5.6 apps/cli/src/md/ — 自绘 markdown 渲染（9 文件 2311 行）

- 分层：lex()（marked GFM + LaTeX 扩展，全仓唯一实例）→ renderBlock（块级分发）→ 行内/表格/高亮/公式 → wrapText（width.ts）折物理行；
- streaming.ts：**稳定前缀冻结**——只对未冻结尾段 lex；完整闭合 code token 即刻定格着色；引用式链接双面守卫；trimPartialClosingFences 防高度抖动；尾段 transient 跳高亮防 O(n²)；
- latex.ts（962 行）：LaTeX → Unicode 线性化（分式恒单行，失败回退原文）；
- table.ts：全边框网格 + 三级列宽分配，行高超 4 降级 key-value。

### 5.7 工具模块组（packages/modules/ 十个 tool-*，除 tool-subagent）

#### tool-fs（src/index.ts，724 行）— 文件工具

`provides: [FS]`，5 工具：read（行号 `N→text`，缺省 2000 行，>1MB 拒绝，>8KB 单行截断，mtime 去重）/ write / edit（基于原文件同时匹配 + 重叠检测 + replaceAll 语义 + CRLF 容差）/ glob（自实现 globToRegExp，只跳 node_modules 与 .git）/ grep（正则先验拒绝嵌套量词；单行 4096、命中 200 早停）。

关键机制：LocalFs root = process.cwd()（realpathSync 归一），safe() 词法前缀 + realpath 双检防符号链接外指；写前比对 writeGuard——read 记录 mtime，write/edit 时内容快照不同则拒绝。

#### tool-shell（src 760 行，index 321 + jobs 350）— Shell 执行

3 工具：bash（前台/后台；超时上限 120s，超时杀整进程树——win32 taskkill /T /F、POSIX -pid SIGKILL）/ output（后台输出尾部，字符语义，CJK 不劈半）/ kill。

关键机制：win32 探测 Git Bash（排除 WSL 桩），回落 cmd + cmd 方言护栏（28 个 POSIX 命令黑名单拦截 + 报错就地翻译）；前台捕获头尾各 256KB；后台作业 id `bg-<8hex>`，输出 fd 直写零内存，完成经 agent/follow-up 通知；writeOutputTo 经 FS 服务落盘；workdir 记忆（仅退出码 0 更新）。

#### tool-web（src 1123 行）— 网页抓取与搜索

2 工具 + 1 命令：fetch（URL 深读）与 search（关键词发现）分工明确；tool-web__settings 配置流。

- fetch：http 自动升级 https；逐跳 SSRF 校验（私网段 BlockList 含 CGNAT 100.64/10）；10 跳重定向帽；10MB 响应体帽；100_000 字符输出截断（转换后）；HTML→markdown 经 turndown（懒加载单例）；CF challenge 诚实 UA 重试；
- search 三后端：llm → tavily → brave 降级链；MAX_RESULTS=8；llm 档「真搜过」判据 = server-search chunk；NATIVE_SEARCH_FACES 端点表经 tool-web.search-faces 服务供 provider-custom 改道；
- 密钥只落 ~/.orosus/secrets.env（0600），config 写 $ENV:XXX 占位符。

#### tool-ask（94 行）— 用户提问

ask_user：问题串行（readline 非并发安全），有 options 走 choose；Esc 取消与无头环境二分处理。

#### tool-goal（268 行）— 会话目标

3 工具：create / get / update(complete|blocked)。单目标纪律；OBJECTIVE_MAX=4000；blocked 三连判定按续跑轮；maxRounds 预算耗尽自动置 blocked；agent/follow-up 每轮注入目标提醒。

#### tool-search（136 行）— 延迟工具目录

search meta 工具：目录源 = tools.list({deferredOnly:true})；打分表（精确名短路 1000 / 名词 10 / 子串 5 / hint 4 / 描述 2）取前 5；命中 tools.reveal 下一轮可调。

#### tool-todo（76 行）— 任务清单

todo_write：整表替换；完成后不清掉（全 ✓ 终痕留面板，仅模型显式 [] 清空才真清）。

#### tool-media（1016 行）— 多媒体

5 工具：read_media_file（读图/视频抽帧入会话）/ media_crop / media_downsample / media_convert / video_clip（ffmpeg 在场才注册）。图片 worker 双入口（imaging-worker + media-worker，tsdown 独立打包）；眼睛模型旁路转述（非 vision 模型会话吃图两态回放）。

#### tool-peers（1432 行）— 会话互相感知

6 工具：peers（会话名册）/ claim（认领）/ release（释放）/ memory__write / memory__list / memory__read。共享记忆 git 根分桶（~/.orosus/memory/<git根哈希>/）；记忆导入覆盖语义（每次导入直接覆盖，updated 计数）；模型侧感知注入（每 turn 重装配）。

## 6. 核心业务架构

### 6.1 会话三层装载

主循环每次启动或切换会话时，按三层渐进装载历史，避免大会话整段读盘：

1. **JSONL/SQLite 事件流**（`packages/core/src/session/`）——append-only 事件日志，turn 完成时落盘；回放时从后向前按需读。SQLite 形态提供结构化查询（会话树模块消费）。
2. **会话树索引**（`packages/modules/session-tree/src/`，157 行 src）——目录化会话 + fork 祖先链，提供「翻页可跨 fork 边界」的复合视图。
3. **事件索引 + 三层窗口**（m5-resume-perf 批，23 commit）——装载只取视口附近事件，翻页时按索引补读，懒分页。

### 6.2 main.ts 双循环

`apps/cli/src/main.ts`（1995 行）两套循环并存：

- **行模式 REPL**：`processReplLine`（main.ts:843）逐行处理输入，斜杠命令与自然语言分流；
- **全屏模式**：`runFullScreen`（main.ts:1313）接管 alt-screen，把输入喂进 TUI 组件树。

两模式共享同一回合驱动层（core 的 `loop.ts`）：一次用户输入 = 一个 turn，turn 内工具调用循环直至模型不再发起调用或触发停止钩子。

### 6.3 回合驱动（core/loop.ts）

核心循环结构（简化）：

```text
user input
  → preStep 扩展点（hooks/模块）
  → transformContext（模块可改上下文）
  → LLM 请求（provider 翻译层）
  → 流式增量 → UI 实时渲染
  → toolPreExecute（审批/权限）
  → 工具执行（两阶段）
  → toolPostExecute
  → 循环直至 shouldStop 或模型不再发起调用
  → followUp（单轮跟进）
```

停止条件三层：模型不再发起调用 / shouldStop 钩子返回 true / 外部 cancel（Esc 双击、/quit 打断）。

---

## 7. 数据流与事件流

### 7.1 十一个核心扩展点（CORE_POINTS）

按数据流顺序，主循环上的可拦截点：

| # | 扩展点 | 时机 | 说明 |
|---|--------|------|------|
| 1 | `preStep` | 每步前 | 模块/钩子可在步前注入或改写指令 |
| 2 | `transformContext` | 请求组装后 | 模块可改最终发给模型的上下文（不落盘） |
| 3 | `steering` | 流式中 | 用户中途插话（steering）注入流 |
| 4 | `followUp` | 单轮后 | 单轮跟进（不新开 turn） |
| 5 | `shouldStop` | 工具循环判定前 | 返回 true 提前终止工具循环 |
| 6 | `preInput`（事件 `tool/pre-input`） | 工具执行前 | 输入拦截/改写 |
| 7 | `toolPreExecute` | 工具执行前 | 审批、权限门、模块前置拦截 |
| 8 | `toolPostExecute` | 工具执行后 | 结果后处理（如工具行聚合） |
| 9 | `uiCommand` | 斜杠命令解析时 | 模块注册斜杠命令 |
| 10 | `promptSubmit`（事件 `user/prompt-submit`） | 用户提交输入时 | hooks 协议同步点 |
| 11 | `requestError` | 请求失败时 | 重试/降档/熔断决策点 |

### 7.2 会话事件通道

- `session/start` 三态：新会话 / 恢复会话 / fork 分叉，三路各自的装载行为不同。
- 事件通道容量 `EVENTS_CHANNEL_CAP = 256`：UI 侧消费不及时的背压上限，超出即丢旧保新（实时性优先）。

### 7.3 流式渲染路径

模型流式增量 → 调度器合帧（`MIN_RENDER_INTERVAL_MS = 16`，scheduler.ts:27）→ 增量渲染器投影 → 终端。全屏 TUI 只重投影脏区（m5-render-perf 批），行模式直接拼行输出。工具行按同名紧邻聚合（read/grep/glob 并组计数）。

---

## 8. 模块扩展系统

### 8.1 注册管线

内置模块与外部模块走同一条管线：`defineModule` 声明 → 信任门检查 → jiti 装载（外部）或直入（内置）→ 服务注册（工具/命令/钩子面）→ 热插拔（Ctrl+E 诊断弹窗可见有效集）。

- `builtins.ts` 注册 18 个内置模块（含 multilang，defaultEnabled:false 出厂）。
- 模块能力经服务挂载/消费，不动主体代码（模块领地纪律）。
- 未声明 config schema 的模块拒收一切额外键（config 铁律）。

### 8.2 模块信任门

外部模块默认不受信，需用户在设置中显式信任后才装载其工具面。信任状态落盘在用户配置。

### 8.3 界面贡献点

模块改界面的四个口子（specs 已定案，m5-ui-extension 批落地）：弹窗 / 卡片贡献翻页式 / 控件窗 / 设置服务，编号即实施顺序。

---

## 9. 审批系统（approval）

### 9.1 三档模式

| 内部档值 | 界面档名 | 行为 |
|---------|---------|------|
| `ask-always` | Always Ask | 每次危险操作都问 |
| `ask-risky`（出厂默认） | Ask When Needed | fs.read/fs.write 常规放行、network 放行；subprocess 询问；kind:all 询问 |
| `never` | Never Ask | 全部放行（/yolo 同效） |

### 9.2 危险命令判定（dangerous.ts）

bash 命令用 tree-sitter-bash 解析 AST 判定危险面（`rm -rf /`、管道注入、重定向等）。解析带预算护栏：`PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 }`（dangerous.ts:20）——超预算即判 unanalyzable，fail-closed 走询问。超长命令同样 fail-closed。

### 9.3 敏感路径

`decide.ts:64-65` 两条正则：

- `SENSITIVE_FILE`：`.env*`、`secrets.*`、`id_rsa*`、`*.pem|key|kdbx`；
- `SENSITIVE_DIR`：`.ssh/.aws/.gnupg` 目录。

命中即升格为询问，会话记忆键带路径（`sensitive:<工具名>:<首个敏感写路径>`，win32 小写归一）——「同意 .env 写入」不会外溢成「同意一切敏感写入」。

### 9.4 会话记忆

`allow once` 仅本次；`always for this session` 落记忆键（工具名+参数指纹），会话内免问。落盘记忆不跨项目（项目分桶）。

---

## 10. 上下文压缩（compaction）

### 10.1 三条触发路

1. **阈值自动**：上下文占用逼近窗口上限（contextWindow 兜底链提供窗口值）时自动发起；
2. **溢出救援**：请求被 provider 以超窗报错打回时，先压缩再重试，不直接失败；
3. **手动**：`/compact` 命令立即执行。

### 10.2 v4 摘要载荷

压缩产出六小节结构化摘要 + v4 自包含载荷（`keptUsers` 等字段），恢复会话时不需要原始历史即可续读摘要——装载三层窗口不再依赖全量回放。

### 10.3 熔断

连续压缩失败或压缩后仍超窗时熔断，明确报错不无限循环。

---

## 11. 技能系统（skill）

### 11.1 五轨目录

SKILL.md 按五个轨道扫描（用户级 `~/.orosus/skills` / 项目级 / bundled 等，去重规则：同名高优先级轨道覆盖低优先级）。技能不进系统提示词正文——只有名字和一行描述入索引，模型用 `skill__load` 按需加载全文。

- 摘要（名字+描述）占宽度预算（WIDTH_BUDGETS 锁），正文不占；
- `skill__load` 返回正文首行带文件路径，正文中相对路径按 SKILL.md 所在目录解析（skill-path-baseline 批修复）；
- bundled/ 目录只读铁律——引导首次弹出时 seedBundledSkills 固化到用户目录，不在只读区写盘。

### 11.2 出厂技能 11 件

`packages/modules/skill/bundled/`：batch / code-review / commit / doc-review-cn / doc-review-en / doc-writer / goal-draft / research / simplify / skill-creator / update-config。

---

## 12. 子代理系统（tool-subagent）

子代理常量页在 `packages/core/src/subagent/constants.ts`（想调整改常量即可）：

| 常量 | 值 | 说明 |
|------|-----|------|
| `SUBAGENT_CONCURRENCY` | 8 | 同时在跑硬上限（含前台/后台/孙代理）；先占位再排写闸，超了排队先来先服务 |
| `SUBAGENT_MAX_TURNS` | 100 | 轮数默认上限（双保险丝批 40→100；工种/settings 可声明 -1 不限） |
| `SUBAGENT_MAX_TURNS_CEILING` | 200 | 显式声明轮数的钳位上限 |
| `SUBAGENT_INACTIVITY_TIMEOUT_MS` | 600_000 | 不活动超时（ZCode 同款），可被工具参数覆盖；-1 关 |
| `SUBAGENT_TOTAL_TIMEOUT_MS` | 7_200_000 | 总时长墙钟兑底（kimi 2h 同款）；-1 关 |
| `SUBAGENT_CONCLUSION_TAIL` | 32000 | 结论保尾字符数（qwen 32K 同款） |
| `SUBAGENT_ROSTER_KEEP` | 32 | 花名册保留已结束条数 |
| `SUBAGENT_ID_LEN` | 8 | 代理 id 长度（hex 小写，撞码重生成） |

关键行为：**嵌套满载快败**（runner.ts:298）——孙代理发现 8 位已满立即失败不排队（防父子互等槽位死锁）；写闸（整仓写预留）等待期间并发位不撒手；后台子代理完成后结论自动回送主对话。

工具参数面（[tool-subagent] index.ts）：`maxTurns`（-1 或 1-200）/ `inactivityTimeoutMs` / `totalTimeoutMs` 可逐次覆盖常量页默认值。

---

## 13. 性能优化策略

### 13.1 关键锚点

| 锚点 | 位置 | 作用 |
|------|------|------|
| thinkingMemo | core/harness.ts:1013 | 思考块跨回合 memo，避免重复请求 |
| requestSig 缓存 | core/loop.ts:167-169 | 请求签名比对，同签名不重试发 |
| usage 锚点 | core/harness.ts:454 | 用量统计写回 |
| `MIN_RENDER_INTERVAL_MS = 16` | tui/scheduler.ts:27 | 渲染合帧（约 60fps），流式增量合帧后一次投影 |
| `SIDEBAR_SWITCH_COOLDOWN_MS = 500` | fullapp-types.ts:255 | 侧栏切换冷却防抖 |
| OUTPUT_LIMIT | tool 层 | 工具输出回截 32768 字符 |

### 13.2 双层滑窗 + 懒分页

- **DocModel 双层滑窗**（m5-render-perf / m5-agentview-perf）：文档渲染只持视口附近行；子代理查看窗常驻 DocModel 增量喂（mtime/size + 字节偏移续读 + live 1s 龄门），不再每帧全量读盘重放。
- **会话装载三层窗口**（m5-resume-perf）：装载只取视口附近事件，翻页按事件索引补读；fork 复合视图跨祖先链拼页。

### 13.3 流式渲染

流式增量不逐帧投影：调度器按 16ms 合帧后一次增量投影（只重投影脏区）。工具行同名紧邻聚合（read/grep/glob 并组计数行）；纯查询工具行收进实时组不刷屏。

---

## 14. 依赖关系图

### 14.1 workspace 包（25 个）

```text
release/（聚合发包 orosus）
  └─ 拷贝 dist/bundled/assets（tsdown 三入口）

apps/cli（orosus CLI 入口）
  ├─ packages/core（内核：loop/harness/session/provider 面板）
  ├─ packages/contracts（契约：module/provider/tool/fs/home/version）
  ├─ packages/testing（测试基建）
  ├─ packages/i18n（多语言运行时）
  └─ packages/modules/*（全部业务模块）

packages/contracts ← 所有模块依赖（唯一稳定面）
packages/core ← apps/cli（主体，模块不反向依赖 core）
```

### 14.2 模块依赖纪律

- 模块只依赖 `contracts`，不 import core 或彼此（check:boundaries 门禁强制）；
- 模块能力经服务挂载/消费，不动主体代码；
- 主体验需要扩展契约时走契约窗口（批次级决策），不临时开口。

### 14.3 外部运行时依赖（release/package.json）

@jsquash/webp、@modelcontextprotocol/sdk、cli-highlight、jimp、jiti、marked、smol-toml、turndown、turndown-plugin-gfm——全部为纯 JS 做不了的硬活（图像编解码/MCP SDK/语法高亮/TS 装载/markdown 解析/TOML/HTML 反解）。

---

## 15. 构建配置与命令

### 15.1 开发期：直跑 .ts 不构建

Node 22+ `--experimental-strip-types` 直跑 TypeScript，日常开发零构建：`pnpm orosus` → `node --experimental-strip-types apps/cli/src/main.ts`。

### 15.2 发布构建：tsdown 三入口（apps/cli/tsdown.config.ts）

```text
entry = {
  main:           ./src/main.ts                        （bin 入口，shebang 仅注 main chunk）
  imaging-worker: tool-media/src/imaging-worker.ts     （worker 产物平铺 dist 根）
  media-worker:   provider-custom/src/media-worker.ts
}
```

要点：20 个 workspace 包全 bundle（唯一例外 testing）；11 件外部依赖全 external 且必须正则形态（字符串裸名匹配不了子路径 import，@jsquash/webp 等曾被误捆）；worker 双入口按 D4=B（rolldown 对 `new Worker(new URL(...))` 原样保留 .ts 不出 chunk，故手动平铺 + workerEntryUrl shim 探测 .js 优先 .ts 回退）；音效资产 onSuccess 手工拷齐 dist/assets/sounds/。

### 15.3 release.mts 发布门禁

`scripts/release.mts` 编排：①四门（typecheck / lint / docs:check）+ check:boundaries + check:publish-deps ②版本一致性 ③build ④拷盘 release/ ⑤dry-run 出包。`--fast` 可跳过全量 test 门（其余门照跑，发布者自担改动面判断）。`release-lib.mts` 提供 collectBundledPackages + widenVersion。

### 15.4 scripts/ 清单

check-boundaries（模块依赖纪律门禁）/ check-publish-deps / gen-api-docs / gen-extension-catalog / i18n-audit / i18n-gen / i18n-no-raw-cjk / i18n-pack-gen / publish-github.sh / release-lib / release.mts。

---

## 16. 测试与验证

### 16.1 规模与分布

测试文件共 231（复口径：find `*.test.ts` 排除 node_modules/dist）：

| 位置 | 文件数 |
|------|--------|
| apps/cli | 88 |
| packages/modules | 60 |
| packages/core | 39 |
| tests/（跨包端到端） | 36 |
| packages/contracts | 6 |
| packages/i18n + packages/testing | 1 + 1 |

### 16.2 四门验证

日常提交跑「四门」：typecheck / lint / test / docs:check；发布前再加 check:boundaries + check:publish-deps（全量 test 由 release.mts 编排）。

### 16.3 测试纪律

- 日常改码禁全量跑测试——哪里有问题测哪，上限 = 改动波及的模块；全量 + 四门只留批次收官；
- 测试必须注入 sessionsDir 隔离（防泄漏事故实锤在档）；
- 终端命令/测试串行执行，不并发。

---

## 17. UI 双模式详解

### 17.1 行模式 REPL

简单逐行交互：斜杠命令 + 自然语言输入，输出直接拼行写终端。适合脚本化/管道场景（`echo "..." | orosus`）。

### 17.2 全屏 alt-screen TUI（tui/ 目录 40 文件，含 14 个 .test.ts）

核心拆分件（m5-split-fullapp 批，fullapp 族合计 9526 行含测试）：

| 文件 | 行数 | 职责 |
|------|------|------|
| fullapp-keys.ts | 723 | 全屏键路由 |
| fullapp.ts | 549 | 主组件（挂载/卸载） |
| fullapp-types.ts | 501 | 类型与常量（冷却 500ms 等） |
| fullapp-overlay.ts | 471 | 弹窗系统 |
| fullapp-mouse.ts | 360 | 鼠标接管（滚轮/拖选/滚动条/链接） |
| fullapp-dialogs.ts | 349 | 对话框 |
| fullapp-input.ts | 307 | 输入框 |
| fullapp-panels.ts | 290 | 侧栏面板（任务/会话/技能） |
| fullapp-frame.ts | 282 | 帧组装 |

另有 onboarding.ts（922 行，首次引导）与 tasks/hooks/settings/mcp 各专用 UI 件。

### 17.3 自绘 markdown（md/ 目录）

不依赖终端 ANSI 直转，自建渲染管线：blocks（块级拆分）/ inline（行内）/ latex（TeX→Unicode 线性化，962 行 + latex-maps 607 + tokenizer 111）/ highlight（cli-highlight 语法高亮）/ streaming（流式半块渲染）/ table（表格降级线）。宽度与全终端列数同源（宽账本），emoji 散点双列矫正。

### 17.4 交互面纪律

弹窗系统 dock 形态贴输入框上缘；管理类弹窗与输入框同宽；查看窗全屏自动滚底；工具行单行形态；并行子代理树形组展示；历史与实时同形。

---

## 18. 常见问题排查

| 症状 | 定位方向 |
|------|----------|
| Edit 报「未找到待替换文本」 | 工作树 CRLF：多行 oldText 与 LF 规范化不匹配。.gitattributes 已钉 LF；确认工作区刷新（checkout 重拉）后重试 |
| 长流水线命令 exit 0 但输出空 | `head` 提前关管道 EPIPE 杀进程——用 `tail` 读长输出，勿 `grep \| head` |
| 任务后风扇持续高转 | 挂起 vitest 成孤儿满核自旋——清理残留 node/vitest 进程 |
| 会话「卡死」无输出 | 看 session-stop-fetch-failed 实锤：无重试 fetch failed 杀回合 + goal 续跑轮不接错误路径；先看网络，再看日志尾部 |
| Edit 未找到且无老行长文 | 模型复述超长中文行失配（非 CRLF）——用短而唯一的子串作 oldText |
| 全屏模式按键静默失效 | keymatch.ts KEY_TABLE 缺映射（Ctrl+O 实锤 \x0f）；改宿主须重启 CLI 生效 |
| 滚动条顶飞/宽度错位 | BMP 散点 emoji（✅ 等）账本 1 列终端实画 2 列；width.ts 按码点矫正 |
| 模块 toggle 后工具残留 | 模块热插拔假挂载（有效集 diff 未生效）——Ctrl+E 诊断弹窗看有效集 |
| 提示音不响 | Orosus BEL 不调音频，响不响被终端/系统声音方案拿揸 |
| npm 发包 401/EOTP | ~/.npmrc 残留过期 token 顶掉环境变量（首发实锤）；零凭据机器 npm login 在前 |

---

## 19. 后续维护建议

1. **契约窗口节奏**：模块不得反向依赖 core/彼此（check:boundaries 门禁）；新增能力优先经服务挂载，动 contracts 走批次级决策窗口。
2. **常量页优先**：子代理限额、审批预算、渲染间隔等全部集中在常量页/常量行，调参改常量不动逻辑。
3. **行数红线**：main.ts 1995 行、fullapp 族拆分后各件 <800 行；新功能优先落模块或拆分件，防止顶层文件重新膨胀。
4. **宽度账本同源**：UI 拼行宽度必须与浮层渲染同源（FullApp.pickRowWidth()），新增提示行先过 WIDTH_BUDGETS 预算。
5. **多语言三铁律**：i18n-audit（键齐全）/ i18n-no-raw-cjk（禁裸中文）/ i18n-pack-gen（语言包生成）进发布门禁；模块串经 ctx.t。
6. **发布纪律**：release.mts 全绿才发；--fast 仅限改动面为零的发布；双远端推送遵守净化历史纪律（GitHub 公开仓不收 docs/superpowers）。
7. **本文档同步**：结构/模块/常量变更后更新本文档并镜像 `web/md/docs/ARCHITECTURE.md`；文档头尾标生成途径与对账基线。

---

> 本文档由 architecture 技能引导重写（2026-10-08），全文数字实读源码对账：git 基线 b9a3d328，仓 25 包 / 231 测试文件 / 18 内置模块 / 11 出厂技能。
