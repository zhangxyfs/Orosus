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

**Orosus**（中文定名「连山」）是一个模块化 AI 编程助手 CLI——TypeScript 编写、Node 22+ 直接运行（`--experimental-strip-types`，无需编译），由核心内核、契约包和一组可插拔模块组成，内置模块与外部模块走同一条注册管线。

| 功能 | 说明 |
|------|------|
| **多厂商模型接入** | anthropic / openai 两族 wire 协议，TOML 配置自定义 provider，模型目录自动发现 |
| **工具系统** | 15+ 内置工具（文件/shell/网页/目标/待办等），两阶段执行 + Access 权限声明 + 审批漏斗 |
| **审批安全** | 三档模式（ask-always / ask-risky / never），tree-sitter-bash AST 危险命令判定 |
| **上下文压缩** | 阈值自动压缩 + 溢出救援 + 手动 /compact，六小节结构化摘要 |
| **会话管理** | append-only JSONL/SQLite 持久化，项目分桶，fork 分叉 + 会话树 |
| **子代理** | 独立上下文子代理（并发 8 / 100 轮 / 双保险丝），写协调闸防冲突 |
| **技能系统** | 五轨目录扫描 SKILL.md，按需加载全文 |
| **MCP 接入** | stdio / streamable HTTP 双 transport，工具桥接进统一注册表 |
| **双模式 TUI** | 行模式 REPL / 全屏 alt-screen TUI（自绘 markdown、鼠标滚轮、弹窗系统） |

**根项目名**: `orosus`（package.json version 0.1.0，private）
**运行方式**: `pnpm orosus` → `node --experimental-strip-types apps/cli/src/main.ts`

---

## 2. 技术栈

### 2.1 核心技术栈

| 类别 | 技术/版本 |
|------|-----------|
| 语言 | **TypeScript** ^5.6.0（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + verbatimModuleSyntax） |
| 运行时 | **Node.js ≥ 22**（type: module，ESM，直跑 .ts 不构建） |
| 包管理 | **pnpm** workspace（lockfileVersion 9.0） |
| 模块解析 | NodeNext / moduleResolution NodeNext，target ES2023 |
| 测试 | **Vitest** ^2.1.0（node 环境，单配置全仓） |
| Lint | **oxlint** ^1.0.0 |
| 类型检查 | tsc --noEmit（根 + 各包独立 typecheck） |
| 文档生成 | 自研 gen-api-docs / gen-extension-catalog 脚本（docs:check 守门） |

### 2.2 依赖版本清单（dependencies，全部来自各 package.json 实读）

| 依赖 | 版本 | 用途 | 消费包 |
|------|------|------|--------|
| zod | ^4.0.0 | schema 校验（契约/工具参数/配置） | 全部 19 包 |
| jiti | ^2.7.0 | 外部模块 TS 直载（alias 钉 contracts） | core |
| smol-toml | ^1.3.0 | TOML 解析（配置读写） | core / cli / approval / provider-custom / tool-web |
| @modelcontextprotocol/sdk | ^1.12.0 | MCP 客户端 | mcp |
| cli-highlight | ^2.1.11 | 代码高亮（hljs 封装） | cli |
| marked | ^16.4.2 | markdown 词法解析（全仓唯一进口） | cli |
| turndown | ^7.2.0 | HTML → markdown | tool-web |
| turndown-plugin-gfm | ^1.0.2 | GFM 表格支持 | tool-web |
| @types/node | ^22.10.0 | 类型（devDependencies 根） | 根 |
| tsdown | ^0.9.0 | 发布构建（devDependencies 根） | 根 |
| typescript / vitest / oxlint | ^5.6.0 / ^2.1.0 / ^1.0.0 | 工具链（devDependencies 根） | 根 |

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
                    │  main.ts 2174 行 + tui/ + md/ │
                    └──────────────┬──────────────┘
                                   │ import + 装配
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼────────┐        ┌────────▼────────┐        ┌────────▼────────┐
│ @orosus/core   │        │ @orosus/contracts│        │ @orosus/testing │
│ 内核：harness/  │        │ 契约：module/tool│        │ 测试基建：       │
│ kernel/loop/   │────────│ provider/fs/home│        │ fakeProvider/   │
│ session/subagent│       │ /version        │        │ fakeModule      │
└────────────────┘        └─────────────────┘        └─────────────────┘
        ▲                                                    ▲
        │ 装配时注入（宿主经 builtins.ts 收 14 个内置模块）      │
┌───────┴────────────────────────────────────────────────────┴──────────┐
│                     packages/modules/（14 个模块包）                     │
│  工具组：tool-fs / tool-shell / tool-web / tool-ask /                    │
│         tool-goal / tool-search / tool-todo / tool-subagent              │
│  系统组：approval / compaction / mcp / provider-custom /                 │
│         session-tree / skill                                             │
│  全部只依赖 @orosus/contracts（边界检查强制）                              │
└─────────────────────────────────────────────────────────────────────────┘
```

**依赖关系**（workspace 内部，实读各 package.json）:

- `@orosus/contracts` → （无）
- `@orosus/core` → contracts、testing
- `@orosus/testing` → contracts
- `@orosus/cli` → core、contracts + 全部 14 个模块包（devDependencies 同款）
- 各模块包 → contracts（7 个 tool-* 另加 testing 为 devDependencies；tool-shell 加 tool-fs；mcp 加 core+testing+tool-search；session-tree 加 core+testing；tool-subagent 加 approval + core + testing）

**分层铁律**：模块只认契约不认内核（core/src/index.ts:1 注）；CLI 与 tests/ 是 core 的消费者；compaction 的投影逻辑与 core 的 deriveMessages 是「铁律 2 双写」（两侧测试钉一致）。

---

## 4. 目录结构

```
Orosus/
├── package.json                 # 根：scripts 四门（test/lint/typecheck/check:boundaries）
├── pnpm-workspace.yaml          # packages/* + packages/modules/* + apps/*
├── tsconfig.base.json           # strict 全开基线，各包 extends
├── vitest.config.ts             # 单配置全仓测试
├── apps/
│   └── cli/                     # ★ 命令行宿主（66 文件 14311 行）
│       └── src/
│           ├── main.ts          # 入口：子命令→装配→REPL/TUI 双循环（2174 行）
│           ├── builtins.ts      # BUILTIN_MODULES：14 个内置模块清单
│           ├── args.ts          # CLI 旗标解析
│           ├── sessions.ts      # /sessions /fork /title 会话拦截层
│           ├── atfile.ts        # @path / @path#L10-L20 文件引用
│           ├── paste.ts / altpaste.ts  # 剪贴板图片（Alt+V）
│           ├── render.ts        # 双订阅渲染编排（liveChunks + events）
│           ├── theme.ts         # 连山主题 14 色板
│           ├── provider-cmd.ts / home-cmd.ts / module-cmd.ts / prune.ts  # 子命令
│           ├── menu.ts / keys.ts / picker.ts  # readline UI / raw 按键基座
│           ├── skill-settings.ts / subagent-settings.ts / module-*.ts    # 设置面
│           ├── compaction-view.ts  # Ctrl+O 压缩摘要视图
│           ├── tui/             # ★ 全屏渲染层（15 源文件）
│           │   ├── fullapp.ts   # FullApp 全屏主体（2899 行）
│           │   ├── docmodel.ts  # 文档模型：滑窗/账本/缓存（713 行）
│           │   ├── width.ts     # 全仓唯一计宽/折行权威（384 行）
│           │   ├── terminal.ts / fullscreen.ts / scheduler.ts / mouse.ts ...
│           │   └── onboarding.ts / widgets.ts / toolview.ts / popuplayout.ts ...
│           └── md/              # ★ 自绘 markdown 渲染（10 源文件）
│               ├── lex.ts       # marked 唯一进口
│               ├── blocks.ts / inline.ts / table.ts  # 块级/行内/表格
│               ├── latex.ts     # LaTeX → Unicode 线性化（962 行）
│               └── streaming.ts # 稳定前缀冻结流式渲染
├── packages/
│   ├── contracts/               # ★ 契约包（6 文件 1400 行）
│   │   └── src/{module,tool,provider,fs,home}/index.ts + version.ts
│   ├── core/                    # ★ 内核（32 文件 6658 行）
│   │   └── src/
│   │       ├── harness.ts       # createHarness 装配（1413 行）
│   │       ├── index.ts         # 公开出口
│   │       ├── config/          # 分层配置加载/校验/行级写
│   │       ├── diag/            # 诊断日志（按日 jsonl 旁路）
│   │       ├── kernel/          # 模块内核：发现→校验→拓扑→激活→reload
│   │       ├── loop/            # agentLoop + deriveMessages 投影
│   │       ├── provider/        # parseModel 模型路由
│   │       ├── session/         # JSONL/SQLite 存储 + fork + 树索引
│   │       ├── subagent/        # 子代理 runner + 写协调闸
│   │       └── tool/            # 工具注册表 + Access 冲突调度
│   ├── testing/                 # fakeProvider / fakeModule 测试工厂
│   └── modules/                 # ★ 14 个模块包
│       ├── tool-fs/             # 文件读写：read/write/edit/glob/grep
│       ├── tool-shell/          # bash/output/kill（前台/后台作业）
│       ├── tool-web/            # fetch/search（SSRF 防护/turndown/三后端搜索）
│       ├── tool-ask/            # ask_user 用户提问
│       ├── tool-goal/           # goal create/get/update 会话目标
│       ├── tool-search/         # 延迟工具目录 meta 搜索（默认开——2026-09-30 预装批翻开）
│       ├── tool-todo/           # todo_write 任务清单
│       ├── tool-subagent/       # spawn 子代理派生
│       ├── approval/            # 审批（vendored tree-sitter-bash）
│       ├── compaction/          # 上下文压缩
│       ├── mcp/                 # MCP 桥接
│       ├── provider-custom/     # 自定义 provider（anthropic/openai 双 wire）
│       ├── session-tree/        # 会话树视图/建枝
│       └── skill/               # 技能加载（bundled 10 个出厂技能）
├── web/                         # GitHub Pages 静态站（docs.html 等）
├── tests/                       # e2e/集成测试（约 30 个文件）
├── scripts/                     # check-boundaries / gen-docs / publish
├── docs/                        # ROADMAP / developers / api / 方案文档
└── doc/                         # 历次 code review 报告（01-17 编号体系）
```

---

## 5. 核心组件详解

### 5.1 @orosus/contracts — 契约包

**namespace**: `@orosus/contracts`，零运行时依赖（zod 仅 type-only import）。

全部模块共享的公共编程面，六个子路径导出：

#### module/index.ts（1049 行）— 模块注册契约

- `MODULE_API_VERSION = 1`：契约主版本，内核按 N 与 N-1 兼容窗口校验；
- `defineModule<C>(def)`：**身份函数**，仅类型收窄，零运行时处理；
- `ModuleDefinition<C>`：`name`（kebab-case 全局唯一）/ `version`（semver）/ `api` / `dependsOn?`（硬依赖字符串 + 可选依赖）/ `provides?`（能力 key）/ `defaultEnabled?` / `mounts?`（宿主口白名单）/ `config?`（zod schema）/ `logEvents?` / `activate(ctx)` → 可选 `{ dispose }`；
- `ModuleContext<C>`：模块运行时 API 面——`config / configRead / log / ui / llm / services(get/getOptional) / provide / contribute(tool/command/promptSection/configOverlay/card) / session(append/fork/tree/switchTo) / tools(reveal/list/enable) / subagent / events(on/emit) / settings / host`；
- UI 抽象：`CommandUi`（ask/askSecret/choose/confirm 四法 + viewText/dialog 等可选口）、`WidgetSpec`（8 种控件）、`DialogSpec/DialogHandle`、`PopupLayout`；
- 子代理缝：`SubagentSpawnRequest / SubagentOutcome / SubagentRosterEntry / SubagentPort`。

#### tool/index.ts（132 行）— 两阶段工具契约

- `Tool { name 强制 <module>__<tool>; parameters: ZodType; resolveExecution(input) → ToolExecution }`；
- `ToolExecution { accesses?; approvalRule?; matchesRule?; execute(ctx) }`——阶段一声明（无副作用），阶段二执行（唯一副作用点，错误带内不许 reject）；
- `Access` 五形态：`fs.read/fs.write(path 字面路径，不支持 glob)/network(host)/subprocess/all`；缺省 accesses = `[Access.all()]` 独占、空数组 = 不碰资源（fail-closed）；
- `ToolResult { output; isError; truncated?; spill?; denied? }`。

#### provider/index.ts（157 行）— 流式词汇

- `Chunk` 七型：`text/delta`、`reasoning/delta`、`toolcall/argumentsDelta`、`server-search`、`usage`、`finish{kind: stop|length|toolUse|error|aborted, errorCode? 首枚 "context_limit"}`；
- `StreamFn = (ProviderRequest) => AsyncIterable<Chunk>`——Provider SPI 唯一方法；
- 共享纯函数：`classifyContextLimit`（400/413 + 七关键词）、`parseModelsResponse`（`Intl.Collator("en", {numeric: true})` 倒序——numeric 感知使 glm-10 > glm-9.1）、`providerSlotKey(name)` → `` `provider:${name}` ``。

#### fs / home / version

- `FS = "fs"` 公共短名能力 key + `interface Fs { read; write }`；
- `orosusHome(env)`：`OROSUS_HOME` env > `~/.orosus`，单一解析点（resolve 归一 + `~` 展开）；
- `OROSUS_VERSION`（createRequire 读根 package.json，回退 "0.0.0-dev"）+ `OROSUS_USER_AGENT`。

### 5.2 @orosus/testing — 测试基建

三个工厂导出：`fakeProvider(script)`（按脚本产 chunk + abort 收尾 + 耗尽钳位）、`fakeProviderModule(name, script)`、`fakeModule(name, extra)`。全仓 35+ 测试文件消费。

### 5.3 @orosus/core — 内核（32 文件 6658 行）

#### harness.ts（1413 行）— 装配与宿主接口

- `createHarness(options): Promise<Harness>`（harness.ts:254）：配置加载 → 存储构造（resume/fork 分支）→ 事件通道 → 模块发现与信任 → loadModules 装配 → 子代理 runner → 内建命令表 → provider 解析链；
- `Channel`（cap 256 drop-oldest 持久事件面）+ `LiveChannel`（零缓冲流式旁路）+ `forwardingStore`（append 即转发）；
- 内建命令：`/model` `/effort` `/help` `/reload` `/context` + 别名表 `COMMAND_ALIASES`（provider/permission/compact/yolo/auto → 模块命令全名）。

#### kernel/ — 模块内核

| 组件 | 职责 |
|------|------|
| `loadModules`（kernel.ts:94） | 启停过滤 → 重名/静态校验 → 拓扑 → 激活 → required 护栏 → ModuleGraph |
| `buildCorePromptSections` | 核心提示词九节 + 分带表（≤−100 核心 / 0-29 模块引导 / 30 AGENTS.md / ≥40 预留） |
| `activateModules`（activate.ts:147，597 行） | 拓扑序激活 + staged commit 失败回滚 + ModuleContext 全量构造 |
| `createEventBus`（bus.ts:45） | 五模式：on/emit（隔离）、waterfall（fail-closed 否决）、reduce、collect、any；九个核心拦截点 `CORE_POINTS` |
| `resolveTopo`（topo.ts:24） | Kahn + 冲突/缺失/环降级到不动点 |
| `discoverModules`（discover.ts:161） | 四路并行扫描（用户/项目目录 + config source 声明） |
| `loadExternalModule`（loader.ts:32） | jiti 直载 TS，alias 钉 contracts，moduleCache:false 支持 /reload |
| `checkTrust`（trust.ts:68） | 项目级按 entryHash、用户级一次性确认；trust.json 原子写 |

#### loop/ — agent 循环

- `agentLoop`（loop.ts:109）：零策略骨架——每 step 投影 `deriveMessages` → provider 流式 → 工具调用循环 → turn 结束 flush。错误带内处理，context_limit 限次重试；
- `executeGroups`（loop.ts:39）：组间串行、组内并行的工具执行生成器；
- `deriveMessages`（convert.ts:25）：日志投影 → 模型消息（「model-visible means logged」铁律执行点），含 compaction v2/v3 分形与 turn/prune 裁剪重放。

#### session/ — 会话持久化

- `JsonlSessionStore`（jsonl.ts:234，500 行）：append-only + 每文件写队列 + 单写者锁 + lifetimeUsage 跨会话累计；伴生 `repairFile`（撕裂尾自修复）；
- `SqliteSessionStore`（sqlite.ts:75）：node:sqlite WAL，busy_timeout 5000；
- `ForkedSessionStore`（fork.ts:6）：投影 = 父前缀（截至 atEntryId）+ own 追加；
- `encodeCwd`（dir.ts:8）：cwd → 桶名（清洗段 50 字符 + 8 hex sha1）；
- `TreeIndex`（treeindex.ts:38）：`~/.orosus/db/session-tree.sqlite` 索引缓存（mtime+size 增量，fail-open 删库重建）。

**目录布局**：

```
~/.orosus/
├── config.toml / modules.d/*.toml / secrets.env / trust.json / AGENTS.md
├── logs/diagnostic-<YYYY-MM-DD>.jsonl
├── db/session-tree.sqlite
├── modules/<name>/            # 用户级模块代码
├── bg/                        # 后台作业输出
├── cache/models-dev.json      # 模型目录缓存
├── tmp/paste-<ts>.png         # 粘贴图片
└── sessions/<bucket>/<s_xxx>/ # bucket = encodeCwd(cwd)
    ├── agents/session.jsonl | session.sqlite
    ├── agents/agents_<8hex>/agents/session.jsonl  # 子代理会话
    └── spill/spill-<seq>-<callId>.txt             # 工具输出溢写
```

#### subagent/ — 子代理执行口

- `createSubagentRunner`（runner.ts:262，778 行）：单子全流程——ALS 深度门控（孙不能再派）→ 并发槽（8）→ 独立会话 store → forkFrom 带历史开局 → 工具面抄主对话（剥 tool-subagent__*）→ 写协调闸 → 审批转发 → 双保险丝（不活动 600s / 总 2h）→ agentLoop 驱动；
- 常量：`SUBAGENT_CONCURRENCY=8`、`SUBAGENT_MAX_TURNS=100`（上限 200）、`INACTIVITY=600_000ms`、`TOTAL=7_200_000ms`、结论保尾 32000 字符；
- `createWriteGate`（writegate.ts:70）：写协调闸——报备归一、撞车排队、bash/未报备写手算整仓、主对话写预约。

#### tool/ — 工具调度

- `createToolRegistry`（registry.ts:61）：两阶段执行——`plan`（zod 校验 + resolveExecution 声明 + fail-closed 缺省）→ `execute`（waterfall 审批 → 执行 → 32KB 截断 + spill 溢写头 24576/尾 8192）；
- `accessConflict` + `scheduleByAccesses`（schedule.ts:24/41）：冲突矩阵（fs.read×fs.read 恒不冲突；subprocess 与写互斥；all 与一切冲突）+ 贪心分组。

#### config/ 与 diag/

- `loadConfig`（load.ts:130）：出厂默认 → 用户 config.toml+modules.d → 项目 config.toml+modules.d → env（OROSUS_ 前缀）→ CLI 覆盖 → `$ENV:VAR` 占位符解析；
- `writeSectionKey`（write.ts:37）：**行级节区感知写**——保注释/键序/EOL 风格，坏 TOML 拒写；
- `createDiagSink`（logger.ts:53）：按日 jsonl、微任务队列、单条失败不毒化队列。

### 5.4 @orosus/cli — 命令行宿主（66 文件 14311 行）

#### main.ts（2174 行）— 入口与装配

启动序列：`exitCli`（排空后 exit）→ 子命令拦截（provider/sessions/home/module）→ `parseArgs` → 会话分桶 → readline/询问面 → `createSession`（迁移 + createHarness + 注册工具 label）→ `--dump-modules`/`--print`/`--resume` 分流 → 行模式引导 → 图片注册表（Alt+V）→ Ctrl+O → DocModel → 渲染汇点 `sinkFor()` 多路复用 → `attachRender` 双订阅 → SIGINT → `processReplLine`（REPL 与全屏共用单行处理）→ `runFullScreen` / 行模式内层循环。

命令分发四层：CLI 拦截层（会话生命周期 + /help /settings /tasks）→ core 内建表 → 别名表 → 模块注册命令。busy 期分级：`BUSY_EXEC`（即改档：/model /effort /permission /yolo /auto /title /rename /tasks /settings 等）与 `BUSY_BLOCK`（/new /sessions /resume /provider）。

#### 命令清单（详见 17 章 UI 与 6.1 流程）

- 会话生命周期：`/quit /new /fork /sessions(/resume) /title(/rename)`；
- 设置：`/settings(/config)` 七项面板、`/tasks` 子代理任务；
- core 内建：`/model /effort /reload /help /context`（context 已并入 /settings）；
- 别名路由：`/provider /permission /compact /yolo /auto` → 模块命令。

#### 关键实现件

| 文件 | 职责 |
|------|------|
| `atfile.ts` | @path / @path#L10 / #L10-L20 引用；最多 5 个、单文件 50KB |
| `paste.ts` / `altpaste.ts` | 三平台剪贴板取图（PowerShell/osascript/xclip）；vision 预检 |
| `theme.ts` | 连山 14 色板 + truecolor→256 降级 |
| `ansi-guard.ts` | `stripDangerEsc` 危险转义净化（防 OSC 52 偷剪贴板） |
| `sessions.ts` | 列表前 10 倒序、桶闸（只认当前项目桶）、/title 旁路写 |
| `module-diagnostics.ts` | Ctrl+E 诊断弹窗（两日窗口事件聚合） |
| `modpreset.ts` | 极简/完整预设三态现算；锁定 orosus-core/approval/活跃 provider |
| `help.ts` | Tab 补全三职（命令 20 条 / @文件 候选 20 / 模块参数委托） |

### 5.5 apps/cli/src/tui/ — 全屏渲染层（15 源文件）

#### fullapp.ts（2899 行）— FullApp 全屏主体

- 组合 `Term`（终端接管）+ `FullScreen`（alt-screen 行级 diff）+ `FrameScheduler`（16ms 合帧）+ `AppState` 单一状态对象 + `FullAppIO`（30+ 宿主回调缝）；
- 布局：左栏 = 流区 + 队列区 + 输入框（INPUT_MAX_ROWS=5）；右栏 = 运行状态面板（max(8, rows×0.55)）+ 任务清单；侧栏 cols≥100 时 34-40 列；
- 弹窗系统（pendingUi 单槽 + uiQueue FIFO 排队）：**pick**（≥12 项启用过滤，每页 10）、**ask**（secret 盲显 + 草稿快照）、**view**（layout/dock/bottom/live/自定义键 14 保留键）、**dialog**（8 种控件，三型事件）+ 独立通道：诊断（Ctrl+E）、斜杠菜单、引导弹窗；
- 鼠标：SGR+X10 双协议；滚轮窗口栈路由（view>dialog>pick>菜单>诊断>主流区），WHEEL_STEP=1 行、Alt ×5；左键三击选行/双击选词/拖选+自动滚（50ms 脉冲）；滚动条轨道点按/拖动；
- 崩溃恢复：`installCrashHooks`——process exit 同步写 CRASH_RESTORE，uncaughtException 先恢复终端再抛。

#### docmodel.ts（713 行）— 文档模型

chunk/event → 条目 → 行数组投影；条目级 LineCache（宽度级缓存键）；条目行数账本 + `frameWindow(start, maxLines)` 窗口化行源（尾部往头部累加定位）；`trimTurns` 轮次滑窗（keep=15、滞回 5，env `OROSUS_TUI_MAX_TURNS` 覆盖）；`evictFarCaches` 远区缓存淘汰（距视口 >3 轮，1Hz 节流）。

#### 其余组件

| 文件 | 职责 |
|------|------|
| `width.ts` | **全仓唯一计宽/折行权威**：visibleWidth/wrapText/graphemeSpans/osc8LinkAtColumn |
| `terminal.ts` | raw mode + bracketed paste + 序列切分（X10 鼠标 6 字节原子；孤 ESC 30ms 窗口） |
| `fullscreen.ts` | alt-screen 行级 diff + ?2026 同步输出；tmux/screen 降级鼠标档；conhost 底行右角不写满 |
| `scheduler.ts` | 16ms 节流 + 键盘 nextTick 抢占 |
| `onboarding.ts` | 三页定高首次引导（505 行） |
| `widgets.ts` / `toolview.ts` | 只读控件渲染 / 工具明细 diff 行 |

### 5.6 apps/cli/src/md/ — 自绘 markdown 渲染（10 源文件）

- 分层：`lex()`（marked GFM + LaTeX 扩展，全仓唯一实例）→ `renderBlock`（块级分发）→ 行内/表格/高亮/公式 → `wrapText`（width.ts）折物理行；
- `streaming.ts`：**稳定前缀冻结**——只对未冻结尾段 lex；完整闭合 code token 即刻定格着色；引用式链接双面守卫；trimPartialClosingFences 防高度抖动；尾段 transient 跳高亮防 O(n²)；
- `latex.ts`（962 行）：LaTeX → Unicode 线性化（分式恒单行，失败回退原文）；
- `table.ts`：全边框网格 + 三级列宽分配，行高超 4 降级 key-value。

### 5.7 工具模块组（packages/modules/ 七个 tool-*，除 tool-subagent）

#### tool-fs（src/index.ts，566 行）— 文件工具

`provides: [FS]`，5 工具：`read`（行号 `N→text`，缺省 2000 行，>1MB 拒绝，>8KB 单行截断，mtime 去重）/ `write` / `edit`（基于原文件同时匹配 + 重叠检测 + replaceAll 语义）/ `glob`（自实现 globToRegExp，只跳 node_modules 与 .git）/ `grep`（正则先验拒绝嵌套量词 `(a+)+`；单行 4096、命中 200 早停）。

关键机制：`LocalFs` root = `process.cwd()`（realpathSync 归一），`safe()` 词法前缀 + realpath 双检防符号链接外指；**写前比对 writeGuard**——read 记录 mtime，write/edit 时内容快照不同则拒绝（「文件在读取后被修改过」）。

#### tool-shell（3 文件 588 行）— Shell 执行

3 工具：`bash`（前台/后台；超时上限 120s，超时杀整进程树——win32 `taskkill /T /F`、POSIX `-pid SIGKILL`）/ `output`（后台输出尾部，字符语义，CJK 不劈半）/ `kill`。

关键机制：win32 探测 Git Bash（排除 WSL 桩），回落 cmd + **cmd 方言护栏**（28 个 POSIX 命令黑名单拦截 + 报错就地翻译「命令不存在」）；前台捕获头尾各 256KB；后台作业 id `bg-<8hex>`，输出 fd 直写零内存，完成经 `agent/follow-up` 通知；`writeOutputTo` 经 FS 服务落盘；workdir 记忆（仅退出码 0 更新）。

#### tool-web（10 文件 1109 行）— 网页抓取与搜索

2 工具 + 1 命令：`fetch`（URL 深读）与 `search`（关键词发现）分工明确；`tool-web__settings` 配置流。

- fetch：http 自动升级 https；**逐跳 SSRF 校验**（私网段 BlockList 含 CGNAT 100.64/10）；10 跳重定向帽；10MB 响应体帽；100_000 字符输出截断（转换后）；HTML→markdown 经 turndown（懒加载单例 ~1.4MB 推迟）；CF challenge 诚实 UA 重试；
- search 三后端：`llm → tavily → brave` 降级链（auto 档逐档试）；MAX_RESULTS=8；llm 档「真搜过」判据 = server-search chunk，workingModel 粘性；`NATIVE_SEARCH_FACES` 16 条端点表（deepseek/kimi/glm 等）经 `tool-web.search-faces` 服务供 provider-custom 改道；
- 密钥只落 `~/.orosus/secrets.env`（0600），config 写 `$ENV:XXX` 占位符。

#### tool-ask（74 行）— 用户提问

`ask_user`：问题串行（readline 非并发安全），有 options 走 choose；Esc 取消与无头环境二分处理（取消 = isError 停下等用户；无头 = 提示模型这是假设回退）。

#### tool-goal（2 文件 264 行）— 会话目标

3 工具：`create / get / update(complete|blocked)`。**单目标纪律**（已有 active 再 create 报错带现状，replace 可覆盖）；OBJECTIVE_MAX=4000；**blocked 三连判定按续跑轮**（同轮重复不累计、换 reason 清零，streak≥3 才受理）；maxRounds 预算耗尽自动置 blocked；`agent/follow-up` 每轮注入目标提醒（用户消息位，保前缀缓存）。

#### tool-search（134 行）— 延迟工具目录（默认开——2026-09-30 预装批翻开；enabled = false 显式关）

`defaultEnabled: false`。`search` meta 工具：目录源 = `tools.list({deferredOnly:true})`；打分表（精确名短路 1000 / 名词 10 / 子串 5 / hint 4 / 描述 2）取前 5；命中 `tools.reveal` 下一轮可调；目录段 order 21 行数帽 50。

#### tool-todo（76 行）— 任务清单

`todo_write`：**整表替换**（省略 = 读、[] = 清空、全 done = 模型面清空 + 面板终痕）；`onWrite` → `session.append("tool-todo/write")` 是 TUI 任务面板唯一投影通道；promptSection 刻意静态（防击穿供应商前缀缓存）。

### 5.8 系统模块组（packages/modules/ 六个）

#### approval（12 文件 895 行 + vendor）— 审批

三档模式 + 规则链：用户规则（首条命中即止）→ 会话记忆 → 危险门 dangerousGate → 模式基线。tree-sitter-bash（vendored，MIT）AST 判定：sudo 包装、嵌套 shell -c（深度帽 4）、eval、SIMPLE_DANGEROUS、git 不可逆（push --force / reset --hard / clean -f / checkout --）、rm -rf（/tmp 豁免）、chmod/chown -R、dd of=/dev/*、cmd 方言 del/rd /s 双保险；解析预算 500ms/10000 节点，失败降级 unanalyzable → fail-closed 询问。四选面板：批准一次 / 本会话始终允许 / 始终允许（写规则落盘）/ 拒绝。出厂 required=true。

#### compaction（554 行）— 上下文压缩

触发三路：auto（每轮 transform-context，窗口已知按 `floor(窗口×0.8)`、未知按 60_000 tokens）/ manual（/compact 全量送摘）/ overflow（context_limit → 用户消息预算减半）。流程：prune 前置（免 LLM）→ 退避/熔断/rapid-refill 三闸 → 分级保留（auto 保留真实用户消息头尾）→ 六小节结构化摘要 → 收敛检查 → 落 `turn/compaction` 事件。摘要尾部拼 recoveryFooter（指引模型回日志捞细节）；`isRealUserInput()` 区分真实用户消息与模块注入。

#### mcp（2 文件 281 行）— MCP 桥接

transport：config 有 url → StreamableHTTP，否则 Stdio（command/args/env）。工具注册名 `mcp__<server>__<tool>` 三段消毒（非法字符 `_`、超 64 截断 + sha256 前 8 hex 防碰撞）；description/instructions 消毒（4096 截断防 tool poisoning）；`deferred: true` 接 ToolSearch 按需加载；唯一返回 `{ dispose }` 的模块（reload 关连接杀 stdio 子进程）。

#### provider-custom（11 文件 1477 行）— 自定义 Provider

TOML 格式 `[provider-custom.providers.<name>]`：`type = "anthropic"|"openai"`、`baseUrl`（必填）、`apiKey`（`$ENV:` 引用，可省略走本地端点）、`defaultModel`。双 wire 翻译层：anthropic 族 `POST {baseUrl}/v1/messages`（双头鉴权 + anthropic-version；thinking 档位映射 budget_tokens 1024/4096/32000；webSearch 加 `web_search_20250305` 工具）；openai 族 `POST {baseUrl}/chat/completions`（reasoning_effort 原样透传）。空闲超时 300s（unref）。模型目录 models.dev 三级回退（内存 TTL 10min → 网络 → 磁盘缓存 → 内置快照 7 家）。**搜索改道**：openai 槽 webSearch 命中 `tool-web.search-faces` → 改发 anthropic 面。

#### session-tree（157 行）— 会话树

`session-tree__view`（dialog 全屏树视图，Enter switchTo）与 `session-tree__branch <序号|sid>`（按 sourceEntryId 分叉）。唯一显式 `defaultEnabled: true` 的模块。

#### skill（282 行 + bundled 10 技能）— 技能系统

五轨扫描（弱→强）：bundled 垫底 → `~/.agents/skills` → `~/.orosus/skills` → 项目 `.agents/skills` 逐层链 → 项目根 `.orosus/skills`；后入者胜。SKILL.md frontmatter：name（必需）/ description / when_to_use / disable-model-invocation / 未知键丢弃。清单段 order 0：单条 description 截 250、段预算 4000。`skill__load` 工具：accesses 常量声明五轨根（消 TOCTOU）、执行时重扫、运行时去重。bundled 出厂 10 技能（batch/code-review/commit/doc-review/doc-writer/goal-draft/research/simplify/skill-creator/update-config）。

### 5.9 tool-subagent（3 文件 475 行）— 子代理模块

模块壳：消费 contracts 的 `SubagentPort`，把 core 的 `createSubagentRunner` 能力暴露为 `tool-subagent__spawn` 工具（模型可调）；审批模式 auto/ask 可配（`[tool-subagent] model/approvalMode/maxTurns`）；CLI 侧 /tasks（tasks-cmd.ts）与 TUI agent 组显示（subagent-status.ts）是其消费面。

---

## 6. 核心业务架构

### 6.1 一次用户输入的完整生命周期

```
用户输入（REPL / 全屏输入框）
  → processReplLine（main.ts:823）
     ├─ 会话拦截层：/quit /new /fork /sessions /title（sessions.ts:85）
     ├─ CLI 拦截层：/help /settings /tasks（main.ts:914-945）
     └─ 其余 → h.prompt(text, images)
        → harness.prompt（harness.ts:1067）
           ├─ 命令归一化 → 内建表 → 别名表 → 模块命令
           ├─ 单并发守卫（M1：turn 进行中再 prompt 抛错）
           ├─ bus.emit(uiCommand) + ensureHeader + store.append(user/message)
           └─ driveTurn（harness.ts:1002）
              ├─ maybeSteerDateLine()（日期系统行）
              ├─ resolveProvider() 一次性捕获 model/stream
              └─ agentLoop（loop.ts:109）
                 每个 step：
                   ├─ steering collect → agent/steering-message
                   ├─ deriveMessages(全量投影) → bus.reduce(transform-context)★compaction
                   ├─ for await chunk of provider.stream(...)   ← LiveChannel 双投
                   │    ├─ livePush → LiveChannel → TUI 实时显示
                   │    └─ 累积 text/reasoning/toolcall/usage/finish
                   ├─ 落 assistant/message
                   ├─ 有 toolCalls → 全部先落 tool/call → plan → 调度分组
                   │    → executeGroups（组间串行、组内并行）
                   │       每任务 = waterfall(toolPreExecute)★approval 审批
                   │                 → tools.execute → append(tool/result)
                   │                 → bus.emit(toolPostExecute)
                   │    → 回到 step 顶部（下一轮带工具结果）
                   └─ 无 toolCalls → shouldStop/followUp → break
                 turn 结束：emit(turn/end) → session.flush() 落盘
           └─ autoTitle → session/label（≤16 字标题）
```

**要点**：工具调用先批量落日志再执行（防边执行边落破坏投影）；context_limit 错误限次重试一次；`★` 标记模块经 bus 拦截点参与的环节。

### 6.2 模块注册管线（内置与外部同管线）

```
createHarness
 ├─ defs = builtinModules（source:"builtin"，builtins.ts 收 14 个）
 │        + modules（source:"inline"，编程式）
 ├─ discoverModules（discover.ts:161）
 │   ├─ scanDir：~/.orosus/modules（user）+ <cwd>/.orosus/modules（project）
 │   │    入口探测：package.json orosus.module:true → exports["./module"] ?? main；
 │   │    无 package.json → index.ts / index.js
 │   └─ scanConfigSources：config.toml 节的 source = "./x"|"~/x"|"file://"|绝对路径
 │   └─ 项目级覆盖用户级（同名后者胜）
 ├─ checkTrust：项目级按 entryHash（unconfirmed / hash-changed）；
 │              用户级一次性确认；未过 → blocked 待确认桶
 └─ loadModules（kernel.ts:94）
     ├─ resolveSections：启停过滤（defaultEnabled → section.enabled → CLI，disable 优先）
     ├─ validateModule：kebab 名/semver/api 兼容窗口/provides key 规则
     ├─ resolveTopo：能力拓扑（Kahn + 冲突/缺失/环降级到不动点）
     ├─ activateModules：拓扑序 def.activate(ctx) + staged commit 失败回滚
     ├─ required 护栏：required 模块失败 → disposeActivated + 阻断启动
     └─ ModuleGraph（records/tools/services/bus/commands/cards/overlays）
```

**关键点**：三来源（builtin/inline/local）在 loadModules 之后完全同构——同一 validate/topo/activate 管线；差异只在发现与信任环节。/reload 热重载：quiesce → 重发现重信任 → diff（entryHash/配置值）→ 墓碑先行 → 新图激活（复用 bus/tools/overlays）→ 旧图 disposeOwners。

### 6.3 会话持久化与恢复

**写**：每条 `store.append` 入内存镜像 + 写队列批量落盘；构造期零落盘（header 懒写到首个持久事件前，fork 例外即刻落盘）；强制刷盘点 = 每 turn 结束 / setLabel / fork / 子代理收尾。事件信封 `{v:1, id, parentId, seq, ts, type, ...}`——首行恒 session/header。

**读**：resume 经 `openSessionView`（fork 子体递归拼祖辈链，深 32 上限防环）；构造器全量读入 + repairFile 自修复 + verifyChain 链校验。

**compact 接缝**（core 五个接缝，本体在模块）：auto 挂 transform-context reduce 链；overflow 走 requestError → forceOnce → 限次重试；手动 /compact 别名路由；`turn/compaction`/`turn/prune` 两类型 owner 制例外；投影应用 = deriveMessages 纯函数重放（与 config 无关）。

### 6.4 子代理单子流程

```
spawn（ALS 深度门控：孙不能再派、孙无后台）
  → acquireSlot（并发 8；嵌套满载快败）
  → runOne（runner.ts:381）
     ├─ 开子会话 store（agents_<8hex>）+ header 亲缘
     ├─ forkFrom=true → ForkedSessionStore 带主对话历史开局
     ├─ 工具面抄主对话活工具（剥 tool-subagent__* + allowed/disallowed 过滤
     │   + wrapForWriteReceipt 写记账皮）
     ├─ 独立 bus + 独立 createToolRegistry
     ├─ gate.acquire 写协调闸（报备 writePaths；同血缘撞车快败）
     ├─ 审批转发：子 bus toolPreExecute → 主 bus waterfall
     │   （后台任务 park 挂起；被停自动按拒绝收场）
     ├─ 收尾轮：maxTurns 到顶 → 注入总结指令 + 工具全禁
     ├─ 双保险丝：不活动 600s / 总时长 2h
     └─ agentLoop 驱动 → 结论 = 最后 assistant 文本（保尾 32000 字符）
  → SubagentOutcome（id/status/turns/conclusion/error/truncated）
```

后台三禁（模型面纪律，核心提示词 Section）：后台跑完结论自动送回；不预测编造、不重跑同任务、不轮询进度。

---

## 7. 数据流与事件流

### 7.1 三层通道并存

```
1. EventBus（kernel/bus.ts，五模式，模块拦截点）
   on/emit（隔离继续）│waterfall（fail-closed 否决）│reduce（改值）│collect│any
   九个核心拦截点 CORE_POINTS：
   agent/pre-step、agent/transform-context(reduce)、agent/steering、agent/follow-up、
   agent/should-stop、tool/pre-execute(waterfall)、tool/post-execute、
   ui/command、agent/request-error

2. Channel（harness.ts:159，持久事件面）
   forwardingStore：一切 store.append → Channel.push → h.events() 单订阅者
   零订阅者缓冲上限 256（drop-oldest）；完整历史走 history()

3. LiveChannel（harness.ts:209，流式旁路）
   loop 每 chunk livePush → LiveChannel → h.liveChunks() 多订阅者
   零缓冲、断连即弃、不持久、不进 SessionEvent 流
```

### 7.2 流式 chunk 完整路径

```
provider adapter（AsyncIterable<Chunk>）
 → trackedStream 包装（usage 锚点记录）
 → agentLoop for-await 分派
    ├─ livePush → LiveChannel → TUI 流区实时渲染
    └─ 类型累积（text/reasoning/toolcall/usage/finish）
      → assistant/message / tool/call / tool/result / turn/end
        → store.append → forwardingStore → Channel → h.events()
        → 写队列 drain → session.jsonl / session.sqlite（事实源）
```

### 7.3 工具调用的审批与调度时序

```
模型发出 toolCalls
  → 全部 tool/call 先批量落日志
  → 逐个 tools.plan()（zod 校验 + resolveExecution 声明 accesses/approvalRule）
  → scheduleByAccesses 贪心分组（冲突矩阵：fs.read 并行；写/subprocess 互斥）
  → executeGroups：组间串行、组内并行
      每任务：
        bus.waterfall("tool/pre-execute")
          → approval 决策管线（用户规则→会话记忆→危险门→模式基线）
          → ask? → CommandUi.choose 四选面板（用户）
          → deny → { output: reason, isError: true, denied: true }
        → tool.execute（唯一副作用点）
        → 输出 >32KB 截断 + spill 溢写（头 24576 / 尾 8192）
        → session.append(tool/result) → bus.emit("tool/post-execute")
```

---

## 8. 模块扩展系统

### 8.1 扩展机制总览

| 机制 | 说明 |
|------|------|
| **内置模块** | builtins.ts 收 14 个，source "builtin"，永免信任门 |
| **外部模块目录** | `~/.orosus/modules/`（用户级）+ `<cwd>/.orosus/modules/`（项目级）；一级子目录即模块 |
| **声明式 source** | config.toml 节带 `source = "<路径>"` 键即按声明加载（`./`、`~/`、`file://`、绝对路径；npm: 前缀 M3 未落地 warn 跳过） |
| **模块配置** | `~/.orosus/modules.d/<名>.toml` 一模块一 TOML（存量 config.toml 模块节自动迁移，.bak 备份） |
| **信任门** | 项目级按整目录 sha256 entryHash（防投毒）；用户级一次性确认；trust.json 原子写 |
| **装载** | jiti 直载 TS，alias 把 @orosus/contracts 钉到宿主源码（压制第二份契约）；moduleCache:false 支持 /reload |

### 8.2 外部模块示例骨架

```typescript
import { defineModule } from "@orosus/contracts/module";
import { defineTool, Access } from "@orosus/contracts/tool";

export default defineModule({
  name: "my-module",
  version: "0.1.0",
  description: "示例",
  api: 1,
  activate(ctx) {
    ctx.contribute.tool(defineTool({
      name: "my-module__hello",
      description: "Say hello",
      parameters: z.object({}),
      resolveExecution: async () => ({
        accesses: [],                    // 不碰资源
        approvalRule: "my-module__hello",
        execute: async () => ({ output: "hello", isError: false }),
      }),
    }));
  },
});
```

### 8.3 模块生命周期

```
发现（scanDir/scanConfigSources）→ 信任门（trust.json）
  → 静态校验（kebab/semver/api 窗口/mounts 白名单）
  → 拓扑排序（能力依赖 Kahn；冲突/缺失/环降级到不动点）
  → 激活（def.activate(ctx)，staged commit 失败回滚）
  → 运行（contribute 注册 + bus 监听 + services get/provide）
  → /reload 热重载（diff → 墓碑 → 新图激活 → 旧图 dispose）
  → dispose（模块停用/替换）
```

### 8.4 技能系统（五轨）

```
弱 → 强（后入者胜 = 项目压用户 + 品牌压通用）：
  bundled/（出厂垫底，可被覆盖）
  ~/.agents/skills/          （用户·通用）
  ~/.orosus/skills/          （用户·品牌）
  .agents/skills/ 逐层链      （项目·通用，git 根到 cwd 每层）
  <git根>/.orosus/skills/    （项目·品牌，只认 git 根本身）

SKILL.md frontmatter：name（必需）/ description / when_to_use /
                     disable-model-invocation / 未知键丢弃
清单段（order 0）：单条 description 截 250 字符；段预算 4000 超限降级纯名单
skill__load：执行时重扫（新放技能指名即载）；运行时去重省 token
```

---

## 9. 审批系统（approval）

### 9.1 决策管线

```
decide()（decide.ts）：
  用户规则（[approval] rules，配置序首条命中即止）
    → 会话记忆（「本会话始终允许」Set）
    → 危险门 dangerousGate()（AST 判定；never 模式整门短路）
    → 模式基线：
        ask-always：仅纯 fs.read 放行，其余询问
        ask-risky（默认）：敏感路径写/subprocess/all 询问；network、常规读写放行
        never：全自动放行（用户 deny 规则仍生效）
```

### 9.2 危险命令判定（tree-sitter-bash AST）

| 类别 | 判定内容 |
|------|----------|
| 特权/包装 | sudo/doas；env/command/exec/nohup/nice/busybox 包装 |
| 嵌套 shell | `-c` 递归（深度帽 4）、eval |
| 不可逆系统 | shutdown/halt/poweroff/reboot/bcdedit/diskpart/format/mkfs/wipefs；init/telinit 0\|6；systemctl poweroff/reboot |
| 设备写 | dd of=/dev/*（白名单 /dev/null\|zero\|full\|random\|urandom\|std*） |
| git 不可逆 | push --force、reset --hard、clean -f、checkout -- |
| 递归权限 | chmod/chown -R / --recursive |
| 删除 | rm -rf（/tmp、/temp 操作数豁免）；cmd 方言 del/rd/rmdir /s 独立判定 |

解析预算 `{timeoutMs: 500, maxNodes: 10_000}`；失败/hasError → unanalyzable → fail-closed 询问；正则清单兜底。

### 9.3 敏感路径与规则配置

- 敏感路径：`.env*` / `secrets*.*` / `id_rsa*` / `*.pem|*.key|*.kdbx` / `.ssh|.aws|.gnupg` / `.git/config`；
- 规则三形态：全名 `tool-fs__read` / 后缀通配 `tool-fs__*` / 带参 `tool-shell__bash(git *)`；effect allow/ask/deny；
- 落盘：mode 写生效层；allow 规则写 `[approval] rules`（多段命令生成 `bash(<段1> && <段2>)`）。

---

## 10. 上下文压缩（compaction）

### 10.1 触发与阈值

| 触发路 | 阈值 |
|--------|------|
| auto（每轮 reduce） | 窗口已知 `floor(窗口 × 0.8)`；未知 60_000 tokens（CJK 1:1、其余 4 字符/token、图 1000/张启发式；有 lastUsage 锚点用增量估算） |
| manual（/compact） | 0（全量送摘，旁路退避熔断） |
| overflow（context_limit） | 下轮强制；用户消息预算减半（20_000→10_000 / 头 2_000→1_000） |

### 10.2 压缩流程与恢复

```
compactOnce：
  阈值判定 → prune 前置（超长 toolResult 裁头尾，免 LLM）
  → 退避闸（失败后需再增长 5% 才重试）
  → 熔断（连续 3 次失败停手）/ rapid-refill 熔断（压缩后新增 <3 条又超阈，3 次停手）
  → 分级保留（auto：真实用户消息头尾预算 keepUserAt 下标集）
  → 摘要输入预收缩 → 六小节结构化摘要（前次摘要合并）
  → 收敛检查（压后必须更小）→ 恢复页脚 → 落 turn/compaction 事件
```

**恢复**：摘要尾部 recoveryFooter 指引模型回 `~/.orosus/sessions/` 日志 grep 捞细节（append-only 不丢）；keepUserAt 随事件落盘，冷启动重放由 core convert.ts 应用同一变换（铁律 2 双写，测试钉一致）。Ctrl+O 全屏/行模式回看全部历史压缩摘要（/summary 已退役）。

### 10.3 压缩载荷 v4 自包含与会话窗口装载（m5-resume-perf）

**v4 载荷**（`turn/compaction`，2026-10-05 起）：`{ trigger, summary, keepUserHead, keptUsers, elidedCount, droppedCount }`——`keptUsers` 为保留用户消息的**完整投影形态**内联（stripImages 后的 ModelMessage 快照，含部件边界与 origin；`elidedCount` = MI-12 真省略数 `总条目−保留条目`）。投影分支判据 = `Array.isArray(keptUsers)` 在场性（信封 v:1 后置覆盖抹载荷 v 字段，判据用字段在场性）→ 直接拼 `[头保留, elision, 尾保留, 摘要]`，**不访问 out 历史与下标**——窗口重放（压缩点起读、前缀零装载）与全量重放投影字节一致。老 v2（keepFrom）/v3（keepUserAt 下标回取）事件一字不重写、永远回退全量装载（下标在窗口态全部越界，保留消息会静默丢失）。

**事件索引**（D12 混合形态：文件当账本、数据库当索引）：独立库 `~/.orosus/db/event-index.sqlite`（与树索引同目录不共库、生命周期互不牵连）；表 `event_index(bucket, session_id, seq)` 主键存字节定位（`byte_offset`/`byte_length`，不存正文）+ `event_index_files` stamp 表（mtime+size 双判 + `indexed_bytes` 续读锚）。随 jsonl 追加增量维护（append 从 indexed_bytes 追尾、size 变小全量重建、盘上消失 sweep；建行 = 1MB 块字节扫 + 信封尾锚定嗅探 seq/type，不 JSON.parse 全文）；坏库删本库重建（瞬时锁 BUSY/locked 不删——重建是空库会清零健康索引，treeindex CS-08 同教训）。**增量续读带锚行校验**：从 indexed_bytes 续读前 pread 最后一行验 seq/type 与行记录一致，不符（同 sid 删了重建/外物改写）从 0 重建。**purgeSessionDir 连带清行**：空会话清理（退出漏斗/启动 sweep）顺带 dropEventIndex——防悬空行与同 sid 重建错位。**建行三时机**：①装载路径（T7 嗅探备胎顺手产出 + T11 resume 前单会话预刷新）；②/sessions 列表时机后台全库补建（void 不挡界面——双判命中零成本；**stale sweep（盘上消失行清扫）只在全库形态做**——定向刷新（装载预刷新/翻页追平的单会话条目）不清扫他会话）；③翻页 miss 当场单会话字节扫补建（`eventsBefore` 查空→`indexSingleSession`→重查，几百 ms 一次性）+ **翻页前新鲜度追平**（活会话持续追加后索引落后、翻页锚落在未索引区间会跳段——mtime+size 双判命中零成本跳过、落后增量追平）。**索引是缓存非事实源——任何时刻可安全删除**，删后下次打开走嗅探备胎顺手重建。行嗅探依据：SessionEvent 落盘 = `{...fields, v,id,parentId,seq,ts,type}`（payload 前、信封六键后、type 恒末键）——`,"type":"tok"}` 恰在行尾 + `,"seq":N` 尾部定位。

**三层装载**（JsonlSessionStore，`load:"window"` opt-in——harness 装配层决定）：
| 层 | 判据 | 行为 |
|---|---|---|
| ①全量快路径 | 文件 < 5MB（D6，cc 同值） | 整读 parse（行为零变化） |
| ②索引主路 | ≥5MB 且 lastCompaction 命中 v4 | 头种子（16KB：header/label/fork）+ eventsFrom 连续段 pread——**前面字节零接触**；坏行即降级（装载永不因索引坏而死） |
| ③前向嗅探备胎 | 索引不可用/v2v3/漂移 | 1MB 块前向扫：compaction 必 parse（v4 清零累积器；v2/v3 无条件转全量）、压缩点前跳过 parse、后段入累积器；**扫描产出顺手写索引（本次备胎下次索引）** |

兜底铁律：等价不可证 = 回退全量，宁慢不错。全量消费点（usage/fork 分叉/label 预算外）经 `ensureFull()` 懒升级（T8/T10 接线）；祖先链窗口安全判据：分叉点不在父层窗口镜像内 → 父层先 ensureFull 再切片（fork.ts openSessionView）。`OROSUS_SESSION_LOAD=full` 一键回现状（逃生阀）；行模式恒全量（echoHistory 只翻已载入行）；子代理 store 恒全量（双保险丝天然有界）。resume 耗时埋点 `session.load.resumed { duration_ms, mode: index|sniff|full, fallback? }`。

**感知层**：切会话就地换页（full 模式不退出 FullApp——旧内容留屏、装载完成后原子换 dm 上屏，装载期 isSwitching 门 + toast；/fork 分叉同走就地换页，/new 仍走退出重进——用户拍板）；轮内步级折叠（Alt+S，每轮保留最近 30 步，env `OROSUS_TUI_KEEP_STEPS` 覆盖、0=常开）；**翻到顶懒分页**（PgUp/滚轮到顶 → 防抖 150ms → `h.eventsBefore`（索引取段、一页 500 事件、不设压缩边界——翻过压缩行取压缩前原文）→ `dm.prependHistory` 头部插页；底部锚定滚动几何天然钉住视口；到头 toast「已到会话开头」停触）。输入召回 sidecar `agents/inputs.jsonl`（每条用户键入一行，帽 100——与大会话转录彻底解耦；老会话降级镜像窗口翻）。env 总表：`OROSUS_SESSION_LOAD`（=full 回全量装载）、`OROSUS_TUI_KEEP_STEPS`（步级折叠保留数，0 不折）、`OROSUS_TUI_MAX_TURNS`（轮次滑窗保留数，0 不裁）。

**真机走查清单**：老 v3 压缩会话打开（应全量装载不炸）/ 新压缩会话打开（窗口秒开）/ ↑ 召回（sidecar 池）/ 翻到顶持续上翻 / 翻过压缩行继续取压缩前原文 / 补页后滚回底部（滑窗照常裁）/ Alt+S 步骤收展 / fork 窗外分叉 / 逃生阀 OROSUS_SESSION_LOAD=full / 索引库删除后自动重建。

---

## 11. 技能系统（skill）

见 [8.4 技能系统（五轨）](#84-技能系统五轨)。补充管理面：`/settings → 技能`（Alt+K 停用切换，落 `modules.d/skill.toml` 的 `[skill] disabled` 数组）；清单两剔除 = disable-model-invocation 与 disabled 名单。

---

## 12. 子代理系统（tool-subagent）

见 [6.4 子代理单子流程](#64-子代理单子流程)。补充配置与管理面：

- 配置 `[tool-subagent]`：model（跟随/指定）、approvalMode（auto/ask）、maxTurns（-1 不限或 1-200，默认 100）；
- /tasks：亲缘分组三色行 + 查看窗（保留 500 条）+ 挂起审批应答 + 卸载守卫（后台在跑拒绝卸载）；
- TUI agent 组：kimi 式首行+树状子行（最多 8 行分桶 running→queued→failed→completed）。

---

## 13. 性能优化策略

| 优化项 | 位置 | 说明 |
|--------|------|------|
| **稳定前缀冻结流式渲染** | md/streaming.ts | 只对未冻结尾段 lex；闭合 code token 即刻定格；尾段 transient 跳高亮防 O(n²) |
| **LiveWrap 增量折行** | tui/live-wrap.ts:10 | 已完成逻辑行折一次永不重折，每帧只折尾行 |
| **条目级 LineCache** | tui/docmodel.ts:33 | 缓存键宽度级；errLines/Write 预览/diff 一次解析入场缓存 |
| **轮次滑窗** | tui/docmodel.ts trimTurns | keep=15 轮 + 滞回 5（env OROSUS_TUI_MAX_TURNS 覆盖）；被裁条目整块销毁；resume 即裁 |
| **窗口化行源** | tui/docmodel.ts frameWindow | 只物化视口覆盖条目（请求量 ≤ streamH×2）；账本 O(条目) 纯加法不物化行 |
| **稳态零折行** | docmodel.test.ts:652 钉 | 稳态帧折行调用增量 = 0（性能回归钉） |
| **远区缓存淘汰** | tui/docmodel.ts evictFarCaches | 距视口 >3 轮条目删缓存（1Hz 节流）；丢缓存不丢几何 |
| **16ms 帧调度** | tui/scheduler.ts | MIN_RENDER_INTERVAL_MS=16 合帧；键盘 nextTick 抢占（P95 2.8ms） |
| **行级 diff 输出** | tui/fullscreen.ts | 逐行绝对寻址只写变化行 + ?2026 同步包裹 |
| **侧栏切换冷却** | tui/fullapp.ts:210 | SIDEBAR_SWITCH_COOLDOWN_MS=500 + busy 拒绝（削全量重折尖峰） |
| **thinkingMemo** | core/harness.ts:858 | 目录声明 (槽,模型) 会话内 memo，免每 turn 重读 1.6MB |
| **requestSig 短哈希** | core/loop.ts:149 | 同 turn 内 tools/system/effort 稳定只落一条 request/header |
| **32KB 截断 + spill 溢写** | core/tool/registry.ts:11 | 头 24576/尾 8192；溢写文件名消毒防覆写 |
| **turndown 懒加载单例** | tool-web/html-to-md.ts | ~1.4MB 堆推迟到首次 HTML 抓取 |
| **模型目录三级缓存** | provider-custom/catalog.ts | 内存 TTL 10min → 网络 → 磁盘 → 内置快照；/model 列表毫秒级 |
| **promptSection 静态化** | tool-todo / tool-goal | 清单不进系统提示词、目标段去轮次计数——保供应商前缀缓存 |
| **读 mtime 去重** | tool-fs read | 同文件同窗口重读返回 file_unchanged 通知 |
| **grep 三闸 + 嵌套量词先验拒绝** | tool-fs grep | stat 前置/行长 4096/命中 200 早停；`(a+)+` 静态检测防灾难性回溯 |
| **后台输出 fd 直写** | tool-shell jobs.ts | 内存零累积；前台捕获头尾各 256KB 封顶 |
| **usage 锚点** | core/harness.ts:374 | lastUsage 增量估算免全量重扫 |
| **TreeIndex 增量索引** | core/session/treeindex.ts | mtime+size 双判据；fail-open 删库重建 |

---

## 14. 依赖关系图

```
┌────────────────────────────────────────────────────────────┐
│                       apps/cli（宿主）                      │
│   依赖全部 18 个包；装配 BUILTIN_MODULES 14 个内置模块       │
└──────┬──────────────────────────────┬──────────────────────┘
       │                              │
       ▼                              ▼
┌──────────────┐   dependsOn    ┌──────────────┐
│ @orosus/core │──────────────▶│  contracts   │◀──────────────┐
│              │                │ （zod only）  │               │
└──────┬───────┘                └──────────────┘               │
       │                                                       │
       ▼                              全部模块只依赖 contracts ▼
┌──────────────┐        ┌──────────────────────────────────────┐
│  @orosus/    │        │        packages/modules/*（14）        │
│   testing    │───────▶│ approval·compaction·mcp·provider-custom│
└──────────────┘        │ session-tree·skill·tool-fs·tool-shell │
                        │ tool-web·tool-ask·tool-goal·tool-search│
                        │ tool-todo·tool-subagent                │
                        └──────────────────────────────────────┘
```

模块间细粒度依赖（devDependencies/test 边，运行时零模块互 import）：

- `tool-shell → tool-fs`（FS 服务消费）
- `tool-subagent → approval`（审批转发语义测试）
- `mcp → core, tool-search`（deferred 机制联动测试）
- `session-tree → core`（session 缝测试）
- **服务倒挂首例**：`tool-web` provide `tool-web.search-faces` ← `provider-custom` getOptional 惰性消费（模块互不 import）

---

## 15. 构建配置与命令

### 15.1 常用命令

| 命令 | 作用 |
|------|------|
| `pnpm install` | 安装（frozen-lockfile 于 CI） |
| `pnpm orosus` | 启动 CLI（node --experimental-strip-types 直跑） |
| `pnpm test` | vitest run（全仓单配置） |
| `pnpm typecheck` | tsc --noEmit 根 + 各包递归 |
| `pnpm lint` | oxlint . |
| `pnpm check:boundaries` | 边界纪律检查（contracts 只 zod；模块不 import core） |
| `pnpm build` | pnpm -r build（tsdown，发布用） |
| `pnpm gen-docs` / `pnpm docs:check` | API 文档生成 / 漂移守门 |
| `orosus provider list\|import` | provider 目录校验/导入子命令 |
| `orosus sessions prune [--days N] [--dry-run\|--apply]` | 会话清理（缺省 dry-run） |
| `orosus home path\|migrate` | 数据目录迁移 |
| `orosus module list\|trust\|enable\|disable` | 外部模块管理 |

### 15.2 CI（.github/workflows/ci.yml 四门）

合入 master 与所有 PR 触发：typecheck → lint → check:boundaries → test（ubuntu-latest，Node 22，pnpm 11.6.0，45 分钟超时）。本地 Windows 开发、CI 跑 Linux——win32 专属用例 `it.skipIf` 平台守卫自然跳过，两平台互补覆盖。

### 15.3 配置文件体系

| 文件 | 作用 |
|------|------|
| `~/.orosus/config.toml` + `<cwd>/.orosus/config.toml` | 主配置（项目压用户） |
| `~/.orosus/modules.d/<名>.toml`（及项目层） | 模块配置（一模块一文件，行级写） |
| `~/.orosus/secrets.env` | 密钥（0600；`$ENV:VAR` 占位符引用） |
| `~/.orosus/trust.json` | 外部模块信任登记 |
| env 层 | `OROSUS_*` 前缀（如 OROSUS_HOME / OROSUS_EFFORT / OROSUS_TUI_MAX_TURNS） |

### 15.4 排查：依赖解析失败

- pnpm workspace 协议 `workspace:*` 未生效 → 确认 pnpm ≥ 9（lockfileVersion 9.0）；
- Node 22 以下无 `--experimental-strip-types` → 升级 Node（engines >=22）；
- zod 版本错位 → contracts zod ^4，模块侧 schema 应与宿主同大版本。

---

## 16. 测试与验证

### 16.1 自动测试

全仓 158 个 `.test.ts`（vitest 单配置，node 环境）：

| 区域 | 测试文件数 | 覆盖 |
|------|-----------|------|
| contracts | 5（29 用例） | 契约锚定（frontmatter/排序/Access 语义源文本断言） |
| core | 33 | harness/kernel/loop/session/subagent/tool/config/diag |
| modules | 30 | 各模块单测（approval AST/compaction 投影/mcp 桥接/provider 双 wire/skill 五轨/工具组） |
| apps/cli | 62+ | 命令层 + tui/（fullapp 45 describe）+ md/ |
| tests/（仓根） | 28 | e2e/集成（approval/compaction/trust/reload/boundary/golden-log 等） |

关键等价性测试：`frameWindow == frameLines.slice`（docmodel）；稳态零折行断言；compaction 双写一致钉；main.test.ts 子进程真实拉起 CLI。

运行：`pnpm test`（全量）/ `pnpm vitest run <路径>`（定向）。

### 16.2 Lint / 边界检查

`pnpm lint`（oxlint）；`pnpm check:boundaries`（依赖纪律）；`pnpm docs:check`（生成文档漂移守门）。

### 16.3 手动验证要点

- 启动冒烟：`pnpm orosus` → 首启 /provider 向导 → 对话一轮 + 工具调用一轮；
- 双模式：`--tui line` 与 full 各验一遍（Esc 中止、滚轮、Ctrl+O、Alt+V）；
- /reload 热重载：改 config.toml 模块节 → /reload → 横幅模块数；
- 子代理：派 2 个并行 research → /tasks 查看 → 停止；
- 外部模块：`~/.orosus/modules/` 放一个最小模块 → 信任弹窗 → 激活。

---

## 17. UI 双模式详解

### 17.1 模式判定与切换

启动时一次性判定：`--tui line|full` 旗标 > `[tui] mode` 配置 > TTY 缺省 full / 非 TTY 恒 line。运行期不互切（Ctrl+T 管侧栏开关）。双形态共用 `processReplLine` 单行处理与 `sinkFor()` 渲染汇点多路复用。

### 17.2 全屏 TUI 布局与键位

布局：左栏流区 + 队列区 + 输入框（INPUT_MAX_ROWS=5）；右栏运行状态面板 + 任务清单；cols≥100 时侧栏 34-40 列。

| 键 | 作用 |
|----|------|
| Enter / Alt+Enter / Shift+Enter | 提交 / 换行 |
| Tab / Shift+Tab | 焦点循环 / 权限三档循环 |
| Esc（busy 双击）| 停止生成 + 全停子代理（1s 窗口） |
| Ctrl+T | 侧栏开关（busy 拒；500ms 冷却） |
| Ctrl+O | 压缩摘要回看 |
| Ctrl+U | steer 排队消息 |
| Ctrl+E | 模块诊断弹窗 |
| Alt+V | 粘贴图片 |
| Alt+E / Alt+O / Alt+F | 思考折叠 / 工具明细 / 失败体折叠 |
| ↑↓（空输入）| 历史召回（LIFO） |
| PgUp/PgDn | 模块/任务卡组翻页或流区滚动 |
| 滚轮 / Alt+滚轮 | 1 行/格；Alt ×5 加速 |

注：F1–F12 无绑定（源码注释中的 "F3-F5" 是任务编号非功能键）；Ctrl+C 全屏期不退出（走 /quit）。

### 17.3 行模式（line）

`"> "` 提示符 + readline；Ctrl+O 直出压缩摘要；Alt+V 粘贴；Tab 补全（命令 20 条 / @文件候选 20 / 模块参数委托）；空闲双击 Ctrl+C 退出。

### 17.4 权限三档快捷操作

Shift+Tab 循环 `ask-risky → ask-always → never`（PERM_CYCLE，main.ts:1491）；/yolo = ask-risky 一键、/auto = never 一键。

---

## 18. 常见问题排查

### 18.1 启动失败 / 模块降级横幅显示 ⚠

检查：
- 看横幅/`orosus module list` 的 failed 清单与原因（静态校验失败/activate 抛错/信任未过）；
- Ctrl+E 打开诊断弹窗看两日窗口事件（kernel.module.failed / discover.fail 等）；
- `~/.orosus/logs/diagnostic-<日期>.jsonl` 查详情；
- required 模块（approval）失败会阻断启动——先修配置再启动。

### 18.2 /model 列表为空或模型不可用

检查：
- `orosus provider list` 验证目录可达（/models 5s 超时）；
- `[provider-custom.providers.<name>]` 的 type/baseUrl/apiKey 拼写（type 只认 anthropic/openai）；
- 密钥是否在 `~/.orosus/secrets.env`（`$ENV:` 引用是否生效）；
- `~/.orosus/cache/models-dev.json` 缓存过旧可删（自动回退网络/内置快照）。

### 18.3 工具调用被拒（denied）

检查：
- 当前审批模式（Shift+Tab 或 /permission）——ask-always 下仅 fs.read 放行；
- 是否命中危险命令判定（rm -rf / git reset --hard 等，AST 级拦截不可绕过）；
- 是否命中用户 deny 规则（[approval] rules 对 never 档也生效）；
- 询问面板选「始终允许」可写规则落盘，避免反复询问。

### 18.4 上下文爆了 / 压缩不生效

检查：
- `/settings → 上下文用量` 看当前 tokens 与窗口；
- 自动阈值 = 窗口×0.8（窗口未知时 60_000）——窗口值来自 provider 目录或 config contextWindow；
- 连续 3 次压缩失败会熔断——手动 /compact 旁路重试；
- Ctrl+O 确认压缩历史与 droppedCount；被压细节可让模型 grep 会话日志捞回。

### 18.5 Windows 下 shell 命令行为异常

检查：
- Git Bash 是否在探测路径（ProgramFiles/scoop/PATH）；无则回落 cmd——POSIX 命令会被方言护栏拦截并给 findstr/dir/type 替换建议；
- 输出乱码 → win32 按行先严格 UTF-8 再 GB18030 回落的解码链；
- `OROSUS_TOOL_SHELL=cmd` 可锁定 cmd。

### 18.6 全屏 TUI 花屏 / 残留 / 键位失效

检查：
- 是否在 tmux/screen/zellij 内（鼠标降级档、无 hover 属预期）；
- 终端窗口过小 → 弹窗回退 center80 或 toast「终端窗口太小」；
- 崩溃恢复钩子会写 CRASH_RESTORE——异常退出后终端状态异常，`reset` 命令重置；
- 长 Emacs 式序列（CSI-u shift+enter）需现代终端支持。

### 18.7 子代理不返回 / 任务卡住

检查：
- /tasks 看状态与 turns（maxTurns 100 默认，双保险丝 600s/2h）；
- 后台任务挂起审批会 park——/tasks 应答后恢复；
- 并发满 8 时排队属正常；同血缘写路径撞车会快败重试。

### 18.8 会话找不到 / --resume 失败

检查：
- 会话按项目分桶（encodeCwd）——他桶 sid 直达落空属预期（桶闸）；
- `/sessions` 只列当前桶前 10；`--resume <sid>` 同桶定位；
- 文件撕裂 JsonlSessionStore 会自修复（repairFile）；verifyChain 报孤儿 result 时查是否外部工具写坏。

### 18.9 外部模块不加载

检查：
- `orosus module list` 看 discovered/blocked 状态；blocked = 信任未过 → `orosus module trust <name>`；
- package.json 需 `"orosus": { "module": true }` + exports["./module"]|main|index.ts 任一入口；
- 坏包/无入口 warn 跳过不炸启动——看诊断日志；
- config source 的 `npm:` 前缀 M3 未落地，会 warn 跳过。

### 18.10 @文件引用或粘贴不生效

检查：
- @引用上限 5 个、单文件 50KB（超限跳过并提示，原文保留）；
- `@p#x` 非 L 后缀不解析（支持 #L10 / #L10-L20 / #L10-20）；
- Alt+V 需剪贴板有图且 >100 字节；vision 预检不过（模型不支持）会拦截不发；
- 非 TTY 行模式无 keypress 拦截（altpaste 不挂）。

---

## 19. 后续维护建议

1. **补 compaction MI-12 跨域对齐**：elision 真省略数口径——模块侧已修，core convert.ts:93-98 仍是旧间隙公式，热路径与冷重放的 elision 数字分叉（源码注释明示待 core 域同步）。两侧「铁律 2 双写」测试需同步扩。
2. **tool-fs glob 遍历面收窄**：现只跳 node_modules/.git，dist/coverage 会被遍历（description 已如实告知）；仓库大了 glob 变慢，建议按 .gitignore 或显式排除清单收窄。
3. **后台作业超时缺失**：tool-shell 后台作业 v1 无超时（前台 120s 帽）；长期挂起作业占槽且依赖宿主退出收口，建议加 idle/total 双保险丝。
4. **loop 投影 O(n²)**：每 step 全量 deriveMessages 重投影（loop.ts:143 自注 M1 已知）；长会话 + 大窗口下是最大计算热点，可增量投影或缓存投影结果按 seq 失效。
5. **Windows O_NOFOLLOW 缺失**：jsonl 追加降级 "a" 模式（hardeningNote 审计已留）；win32 平台加固依赖未来 Node 支持，安全敏感场景可文档披露。
6. **网络·MCP 面板**（2026-10-01 已填实销账）：右上卡组第 2 页落地真数据——代理态（批 D proxy-env 语义）+ 模型服务信息行（端点域名 + 末次请求耗时，`assistant/message.durationMs` 带内）+ mcp.catalog 五态连接列表（首连耗时 `McpCatalogRow.connectMs` 被动计时）。主动健康探测（出网/DNS 周期 ping）拍板不做——维持 2026-09-20 TUI 批「另议」缺位口径，被动真值已覆盖展示需求。
7. **approval deny 规则 fail-open latent 风险**：deny 规则 + 无 matchesRule 的带参工具返回 indeterminate → 强制询问（当前安全），但外部工具若声明不当存在 latent 面；建议契约层 lint 提示。
8. **grep 无索引全根重扫**：每次调用 `**/*` 全量扫描；大仓可考虑 mtime 增量或 ripgrep 外挂（需平台适配评估）。
9. **elision/摘要文案与 /context 退役遗留**：/context 内建仍注册但已退役出补全清单——要么正式移除要么恢复文档口径，避免双口径困惑。
10. **doc/ 审查编号体系固化**：CH/CS/CX/CK/CL/CT/CM/MB/MV/MA/MI/CTU/CTW 十三族编号散在注释与 doc/ 报告，建议集中索引页（doc/00-index.md）方便新人按编号溯源。

---

> 文档生成方式：architecture 技能（子代理并行模式）——6 个 research 子代理分域调研（contracts+testing / core / CLI 命令层 / TUI 渲染层 / 工具模块×7 / 系统模块×6），主代理汇总成文并抽查 26 个硬事实全部命中源码。生成日期：2026-09-29。
