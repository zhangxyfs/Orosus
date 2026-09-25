# 模块开发 walkthrough：从零到 /reload


> **给 AI 的提示**：帮用户写模块前先读 `docs/extension-catalog.md`（机器生成的扩展点目录——
> 每个口子一句人话 + 声明形态 + 可抄示例，与契约源永远同步）。
> 这是**教程层**——把人领进门，一步步做一个真能跑的模块。写完之后：
> 速查去 [developers.md](developers.md)，接口签名与逐口示例去 [docs/api](api/README.md)，
> 单个模块的设计取舍去 [superpowers/specs/modules/](superpowers/specs/modules/README.md)。
> 机制依据：主设计文档（v33）§5/§6/§8。

## 0. 三分钟看懂：模块怎么被模型"看见"

一个模块能被模型感知，只有两条通道，都在 `activate(ctx)` 里注册：

| 通道 | 注册口 | 模型看到什么 |
|---|---|---|
| 工具 | `ctx.contribute.tool(...)` | 请求里的 tools 数组——工具名、描述、参数 schema |
| 系统提示词 | `ctx.contribute.promptSection(...)` | 系统提示词里的一节——"什么时候用、怎么配合"的引导文字 |

除此之外的注册口（命令、能力槽、事件、日志）都是给**宿主或别的模块**用的，模型看不见。
反过来说：模块**加载了不会自动进系统提示词**——你不调 `promptSection`，一个字都不会进；
调了但 text 是空串，装配时也会被过滤掉。想要"加载即注入"，就在 activate 里无条件注册、
text 永远返回非空（tool-todo 和 mcp 就是这个形态）。

provider 系模块是另一类：它们只往能力槽里塞实现（`ctx.provide`），是"水管"，模型完全无感。

## 1. 两条路：先外部，后转正

| | 外部模块 | 内置模块 |
|---|---|---|
| 放哪 | `<项目>/.orosus/modules/<name>/` 或 `~/.orosus/modules/<name>/` | `packages/modules/<name>/` + 改 `apps/cli/src/builtins.ts` |
| 加载方式 | 目录扫描 + jiti 直接吃 TS 源码，**不用构建不用发包** | workspace 包 import |
| 信任 | 项目级要 `orosus module trust <name>`；用户级免确认 | 仓库内自带信任 |
| 适合 | 试验、项目定制、第三方分发 | 稳定后转正、要跑全套测试 |

教程主线走外部模块（门槛最低），转正见第 10 节。

## 2. Step 1：写一个 note 模块

做个最简单但五脏俱全的：**会话便签**——模型跨轮次记中间结论的工具。一个文件搞定，
新建 `<项目>/.orosus/modules/note/index.ts`：

```ts
import { defineModule } from "@orosus/contracts/module";
import { defineTool } from "@orosus/contracts/tool";
import { z } from "zod";

export default defineModule({
  name: "note",                      // kebab-case，全局唯一（规则 4）
  version: "0.1.0",
  description: "会话便签——模型跨轮次的临时记事本",
  api: 1,
  config: z.object({                 // 自家配置节 [note]：声明 schema 才读得到
    maxNotes: z.number().int().min(1).default(20),
  }),
  logEvents: ["note/write"],         // 想往会话日志写事件，必须先在这里白名单
  activate(ctx) {
    const notes: string[] = [];

    // 通道一：工具（进请求的 tools 数组）
    ctx.contribute.tool(defineTool({
      name: "note__add",             // 强制 <module>__<tool> 前缀（规则 4）
      description: "Add a short note that persists across turns. Use for intermediate facts, not final answers.",
      parameters: z.object({ text: z.string().min(1) }),
      resolveExecution: async (input) => {
        const { text } = input as { text: string };
        return {
          accesses: [],              // 不碰文件/网络/子进程 → 空声明
          approvalRule: "note__add",
          execute: async () => {
            const { maxNotes } = await ctx.configRead();   // 运行期读自家配置（含 overlay）
            notes.push(text);
            if (notes.length > maxNotes) notes.splice(0, notes.length - maxNotes);
            ctx.session.append("note/write", { notes });   // 落会话日志（TUI/回放可投影）
            return { output: `Noted (${notes.length}/${maxNotes}): ${text}`, isError: false };
          },
        };
      },
    }));

    // 通道二：系统提示词节（使用引导——模型看得到"现在有几条便签"）
    ctx.contribute.promptSection({
      order: 15,                     // 分配表：skill=0 / todo=10 / mcp=20；领空位，别越 30
      get text() {                   // getter——每轮请求装配时读最新值
        return notes.length === 0 ? "" : `## Notes\n${notes.map((n) => `- ${n}`).join("\n")}`;
      },
    });
  },
});
```

几件事说透：

- **`resolveExecution` 和 `execute` 是两阶段**（§6.3）：前者只做声明（无副作用），内核拿它跑
  并发调度和审批瀑布；后者是唯一的副作用点。工具出错**不许 reject**，带内返回
  `{ output, isError: true }`。
- **`accesses` 声明资源**：不声明 = `{ kind: "all" }` 独占（fail-closed）。要读文件就写
  `[{ kind: "fs.read", path }]`，跑命令写 `[{ kind: "subprocess" }]`。宿主据此做并发分组和审批。
- **promptSection 的 order 是全局分配表**：核心五节永远最前（概念 -100），模块段按 order 排，
  AGENTS.md 固定拼尾（等价 30）。现有占用 skill=0 / tool-todo=10 / mcp=20，新模块领空位、
  保持 < 30，别跟别人撞车。
- **第三方依赖**：`@orosus/contracts` 由宿主钉死（外部模块不用装）；但 `zod` 这类第三方包
  按 Node 规则从模块目录向上解析——模块放在本仓库或任何有 node_modules 的目录下没问题，
  放到"空目录"里要自备（模块目录里 `npm i zod`）。

## 3. Step 2：放对地方（目录扫描规则）

内核启动时扫两级目录（§8.3，不递归——子目录本身就是模块）：

- 项目级：`<项目>/.orosus/modules/<name>/`
- 用户级：`~/.orosus/modules/<name>/`（同级同名时项目级覆盖用户级，§8.7）

一个目录怎么算模块（§8.4，任一即可）：

1. 有 `package.json` 且 `"orosus": { "module": true }`，入口取 `exports["./module"]` 或 `main`；
2. 没有 package.json，那就找 `index.ts` / `index.js`。

不想放进 modules 目录的，也可以在配置里声明路径（§8.2）：

```toml
# <项目>/.orosus/config.toml（或 ~/.orosus/config.toml）
[note]
source = "../wherever/note"    # ./ ~/ file:// 或绝对路径；npm: 前缀是 M3 之后的事
```

## 4. Step 3：过信任门（第三方模块必看，m5 T17 起首挂确认）

第三方模块（用户级或项目级）第一次出现都会被拦下——**默认不挂载**，面板模块区显示「待确认」；
选中回车弹一个居中确认窗，列出它的声明面（提供什么服务 / 依赖什么能力 / 用哪些宿主口），
确认开启才真正激活。行模式回退 CLI：`orosus module trust <name>`。

- **弹窗长什么样**：模块名 / 版本 / 来殡（哪层目录）+ 声明面人话清单 + 两句诚实行
  （工具/命令/卡片要激活时才注册，确认前看不到；声明面只覆盖契约口）。Enter 确认 / Esc 取消（取消零副作用）。
- **确认后存在哪**：`~/.orosus/trust.json`（全局一份，跨项目共用）——每个模块目录一条登记。
- **代码变了会怎样**：分层——
  - 项目级（`<项目>/.orosus/modules/`）追内容 hash：改了入口文件就重新弹窗（顶部多一行「⚠ 代码已变更，须重新确认」）——
    这是特性不是 bug：项目里的模块代码变了，你应该再看一眼（防 MCPoison 式投毒）。
  - 用户级（`~/.orosus/modules/`）**一次性确认不追 hash**——自己地盘自己负责，改动不烦（m5 起修订；
    旧规「用户级恒免确认」已废）。
- 确认过再 disable → enable 不重弹（登记还在）；启动时已有待确认模块 → 不挂载 + 一次性提示。
- `orosus module list` 看全量；`enable <name>` / `disable <name>` 管开关。

## 5. Step 4：验证

```bash
# ① 冷启动看清单：模块在不在图里、什么状态
pnpm orosus --dump-modules          # 已安装 CLI 的用户直接 orosus --dump-modules

# ② 会话内热装载（不用重启）
pnpm orosus
> /reload                           # 重新扫描+重建模块图
> 帮我记一下：这个项目的入口是 apps/cli/src/main.ts
> （模型调 note__add，你会在下轮系统提示词里看到 ## Notes）
```

判断"真的生效了"的三个证据：`--dump-modules` 清单里有 `note` 且状态正常；模型真的调了
`note__add`（工具行可见）；再问一句"便签里有什么"它能答上来（说明 promptSection 活段在喂）。

看着"没生效"先查这个：**activate 抛错不会崩启动**，模块只是降级（§11）——在
`--dump-modules` 里看是不是 failed，原因会写在那里。

## 6. Step 5：写测试（脚本驱动，不用真 provider）

仓库里的标准形态（模板：`packages/modules/tool-todo/src/index.test.ts`）——
`fakeProviderModule` 按剧本吐 chunk，`createHarness` 装配全套，断言走会话事件：

```ts
import { it, expect } from "vitest";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import note from "./index.ts";

it("note__add 写入 → promptSection 出现 Notes 节", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orosus-note-"));
  const script: Chunk[][] = [
    [
      { type: "toolcall/argumentsDelta", callId: "c1", name: "note__add",
        argumentsDelta: JSON.stringify({ text: "入口在 apps/cli" }) },
      { type: "finish", kind: "toolUse" },
    ],
    [{ type: "text/delta", text: "记下了" }, { type: "finish", kind: "stop" }],
  ];
  const mem = new InMemorySessionStore();
  const h = await createHarness({
    store: mem, diagDir: dir, spillDir: join(dir, "spill"),
    modules: [note, fakeProviderModule("fake", script)],
    config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
  await h.prompt("记一下：入口在 apps/cli");
  const sections = h.graph().promptSections();   // close 前读——close 拆图
  await h.close();
  expect(sections).toContain("## Notes");
  expect(h.graph().audit().some((a) => a.name === "note")).toBe(true);
});
```

工具逻辑本身还可以更轻：像 tool-todo 那样把工具做成**工厂**（`createTodoTool` 的形态），
单测直接 `resolveExecution` + `execute` 驱动，不装配 harness。

## 7. 给模块做界面（m5 起：弹窗 / 卡片 / 控件窗 / 设置）

m5 之前模块在界面上只能"给内容"（工具行、斜杠命令、黄字提示）；m5 起能"给界面"了——四条路：
**弹窗**（只读文本窗）、**卡片**（右侧面板常驻卡）、**控件窗**（列表/进度条/输入框，用户操作变事件）、
**设置服务与读面**（改模型/切挂载预设 + 看运行状态）。铁律只有一条：**你给数据，宿主画**——
文字不许夹终端颜色控制码（宿主按看得见的宽度算折行，夹了必炸）。

### 7.1 UI 怎么写：弹窗与卡片

弹窗（`ctx.ui.viewText`）与卡片（`ctx.contribute.card`）都是 activate 期注册、运行期随时调：

```ts
// 在 note 模块的 activate 里接着加——命令：弹窗查看全部便签（带自定义键 r 刷新）
ctx.contribute.command("show", async (_args, ui) => {
  if (notes.length === 0) { await ui.notice?.("还没有便签"); return ""; }
  ui.viewText?.("便签", notes.map((n, i) => `${i + 1}. ${n}`).join("
"), {
    keys: { r: { label: "刷新", run: () => notes.map((n, i) => `${i + 1}. ${n}`).join("
") } },
  });
  return "";
});
// 用户敲 /note__show 开窗；窗内按 r 整窗换新内容；Esc 关窗。
// 键名用 keymatch 规范名（"r"、"alt+r"、"pageUp"）；Esc 和 Ctrl+C/V/A/S/Z 是保留键，注册会被拒。

// 卡片：右侧面板常驻一张（widgets 是 getter——宿主每秒现读，改个变量卡片自己跳）
ctx.contribute.card?.({
  area: "bottom",                  // "top" = 右上（运行状态那排后面）；"bottom" = 右下（任务清单后面）
  order: 50,                       // 内建卡固定在前，模块卡按 order 排后
  title: "便签",
  get widgets() {
    return notes.length === 0 ? [] : [
      { id: "count", kind: "kv", label: "条数", value: String(notes.length) },
      { id: "latest", kind: "text", text: notes[notes.length - 1]!, style: "muted" },
    ];
  },
});
// 卡片声明 mounts：["contribute:card"] 才能注册（见下方"门"说明）。
```

**门（mounts）**：模块一旦声明了 `mounts` 数组，它就是白名单——用哪个口就得列哪个。
卡片要列 `"contribute:card"`；设置服务要列 `"settings"`；没声明 mounts 的模块不受限。
窗是排队的一次一窗（连弹两窗后者等前者关）；模块被卸载时它的窗和卡会被自动关掉/拆掉。

### 7.2 控件怎么用：控件窗与事件

控件窗（`ctx.ui.dialog`）交一份控件清单，宿主代画；用户的操作变成事件回传给你：

```ts
// 命令：便签管理窗（列表选中 + 回车删除 + 进度条显示容量）
ctx.contribute.command("manage", async (_args, ui) => {
  const refresh = () => [
    { id: "list", kind: "list", interactive: true, items: notes.map((n, i) => `${i + 1}. ${n}`) },
    { id: "cap", kind: "progress", value: () => notes.length, max: 20 },  // 上限演示用固定值——正式代码读 ctx.configRead()
  ];
  const h = ui.dialog?.({
    title: "便签管理",
    widgets: refresh(),
    onEvent: (e) => {
      if (e.type === "activate" && e.id === "list") {   // 回车激活列表项
        notes.splice(e.index ?? 0, 1);
        return refresh();                                // 回新清单 = 整窗替换
      }
      return undefined;                                  // 无返回 = 不动
    },
  });
  if (h === undefined) { await ui.notice?.("当前宿主不支持控件窗"); return ""; }
  // 句柄在异步处也能用：h.update(新清单)、h.close()——窗关了再调是无操作不报错
  return "";
});
```

事件三型：`input`（输入框内容变，每键一回）/ `select`（列表选中变）/ `activate`（回车）。
控件八种：text（文字）/ kv（标签值）/ sep（分隔线）/ list（列表）/ progress（进度条）/
input（输入框，单行或多行）/ columns（多列，可嵌套）/ table（表格）。文字字段可以给函数
（活值）——渲染期现读，进度条自己跳就是它。输入框聚焦时方向键归输入框（移光标），Tab 换焦点。

### 7.3 数据怎么绑：读面与缓存惯例

看运行状态（当前模型/力度/挂载模式/权限/用量）走 `ctx.host.current()`——只读、不用声明 mounts：

```ts
let snap: import("@orosus/contracts/module").HostSnapshot | undefined;
ctx.host?.current().then((v) => { snap = v; });                 // activate 拉首份
ctx.events.on("turn/end", () => { void ctx.host?.current().then((v) => { snap = v; }); });  // 事件刷新
ctx.contribute.card?.({ area: "top", order: 60, title: "状态",
  get widgets() {   // 同步 getter 读缓存——快照是异步的，卡片是同步的，中间靠模块自己缓存
    return snap ? [{ id: "m", kind: "kv", label: "模型", value: snap.model }] : [];
  },
});
```

这就是标准接法：**activate 拉首份 + 事件刷新（turn/start·turn/end 等），同步 getter 读缓存**。
改设置走 `ctx.settings`（声明 mounts: ["settings"]）：setModel/setEffort/applyModulePreset
（"full"/"minimal" 极简模式）/setLabel/setSidebar/readClipboard；busy 期可调、下一轮生效。

### 7.4 规矩清单（界面贡献的边界）

- **给数据不给画面**：不夹控制码、不自己算布局；渲染权、宽度、主题、防闪烁全归宿主。
- **Esc 永远关窗**；Ctrl+C/V/A/S/Z 与宿主全局键（Ctrl+T/E/O 等）是保留键，注册即拒。
- **一次一窗**（后来的排队）；模块卸载 = 窗关、卡拆、句柄作废（之后调句柄静默无操作）。
- **出错诚实降级**：你的函数抛错 = 该卡当帧剔除/窗保留 + 黄字提示，别的不受牵连。
- **宿主可能没有这些口**（行模式/无头）：全部判空调用（`ui.viewText?.(...)`、`if (ctx.settings)`），
  降级路径自己想好（比如回退 notice）。

## 8. 进阶口速览（每个都是两三句话 + 文档指针）

| 口 | 干什么 | 什么时候用 |
|---|---|---|
| `ctx.config` / `configRead()` | 自家配置节的快照 / 运行期活读 | 声明了 `config`（zod schema）才有；overlay 只作用于 configRead |
| `ctx.contribute.command` | 注册 `/<module>__<cmd>` 命令 | 宿主操作面（人用的），不是模型用的 |
| `ctx.contribute.configOverlay` | 改**别人**配置节的读侧投影 | 要按运行态修饰他人配置时；须 `uses` 含 `config.foreign` |
| `ctx.session.append` | 写会话日志事件 | 必须先 `logEvents` 白名单；给 TUI 投影/回放/别的模块读 |
| `ctx.session.messages()` | 读当前会话的模型消息投影 | 要看"模型现在看到什么"的模块（compaction 就吃这个） |
| `ctx.events.on` / `emit` | 监听/发事件 | 拦截点白名单 8 个见 developers.md；模块间通知走 `<module>/*` 命名空间 |
| `ctx.llm.stream` | 二级 LLM 调用 | 摘要、标题生成类；复用当前 provider/model，不带工具 |
| `ctx.provide` / `ctx.services.get` | 能力槽：给/取 | 模块间解耦协作（fs seam、provider 槽都是这个） |
| `ctx.ui.ask` / `choose` / `confirm` / `notice` | 宿主注入的交互 | 无头环境是拒绝式实现——别指望它一定成功，fail-closed |

每个字段、每个参数的逐条说明见本文**第 13 节（完整 API 参考）**；更长的语义注释去 [docs/api](api/README.md)（`pnpm gen-docs` 从 contracts 源生成——含每个参数的 @param 含义与范围，两处同源）。

## 9. 设计一个新模块的正规流程

本仓库对"设计"有治理（[specs/modules/README.md](superpowers/specs/modules/README.md)）：
一模块一文档、从 `_template.md` 复制起手、八节模板、六态状态机（构想 → 设计中 → 已定稿 →
实现中 → 已落地）。轻量想法只要求写三节（定位/接口需求/决策点），进入"设计中"才八节写全。
核心纪律两条：**模块文档不发明核心机制**——需要核心开新口（比如子代理要够到嵌套 harness），
先走主文档流程登记 D 编号，模块文档只在"前置条件"里引用；**不动主体代码**——需要什么能力
先消费既有服务（`ctx.services`）或挂自己的服务（`ctx.provide`）让别的模块来用，contracts 新
类型走契约窗口攒批，主体 diff 是最后手段（详见 [developers.md 圈地纪律](developers.md#圈地纪律不动主体代码2026-09-24-用户拍板)）。

## 10. 转正：挪进 packages/modules

外部模块稳定后想转正，差异只有三处：

1. 建包 `packages/modules/<name>/`，package.json 抄邻居（tool-todo 是最小样板）：

   ```json
   {
     "name": "@orosus/<name>",
     "version": "0.1.0",
     "type": "module",
     "orosus": { "module": true },
     "exports": { ".": "./src/index.ts" },
     "scripts": { "typecheck": "tsc --noEmit" },
     "dependencies": { "@orosus/contracts": "workspace:*", "zod": "^4.0.0" },
     "devDependencies": { "@orosus/core": "workspace:*", "@orosus/testing": "workspace:*" }
   }
   ```

   入口挪到 `src/index.ts`，测试文件 `src/index.test.ts`（vitest 全仓自动收）。
2. `apps/cli/src/builtins.ts` 里 import 并加进 `BUILTIN_MODULES`。
3. 仓库根 `pnpm install`（链 workspace）→ `pnpm vitest run packages/modules/<name>`。

内置模块与外部模块走同一条 kernel 注册管线，没有特权（规则 5）——转正不改变行为，
只改变归属：进 CI、进门禁、进 docs/api（如果你的契约进了 contracts）。

## 11. 容错契约：你的模块坏了会怎样（第三方开发者必读）

**承诺**：第三方模块出任何问题，止于模块自身——你的模块做不到让程序起不来或运行崩溃（启动有顶层兜底错误面，坏包坏入口在发现期就被跳过，根本进不了图）。

各阶段待遇（坏了会怎样、去哪看）：

| 你的模块怎么坏 | 阶段 | 宿主的处置 | 去哪看 |
|---|---|---|---|
| `package.json` 写坏 / 入口文件读不了 | 发现期 | 跳过该模块，程序照常启动 | Ctrl + E 弹窗「加载失败」；日志 `kernel.discover.skip` |
| 入口代码语法错 / import 期炸 | 发现期 | 同上 | 同上；日志 `kernel.discover.fail` |
| `defineModule` 形状不对（如 provides key 没带 `<模块名>.` 前缀） | 静态校验 | 该模块降级不激活，其余照常 | Ctrl + E「激活失败」 |
| `activate()` 抛错 | 激活期 | 该模块降级，工具/命令不注册，其余照常 | Ctrl + E「激活失败」（详情带堆栈） |
| 硬依赖的能力没有提供者 | 拓扑/激活期 | 级联降级（不激活）；提供者恢复后下次 reload 自动恢复 | Ctrl + E「级联」 |
| 项目级模块没过信任门 | 信任门 | 不纳图（untrusted） | 启动横幅 / `--dump-modules` |

两条运行期拦不住的边界（知情自查）：

1. **顶层代码只做定义，副作用进 `activate()`**。模块顶层在信任门**之前**执行——顶层就抛错的模块宿主拦不住（原理层面：得先执行它才知道它是什么）。最小反例：
   ```ts
   // ❌ 顶层副作用：文件一缺失，宿主直接炸
   const config = JSON.parse(readFileSync("notes.json", "utf8"));
   export default defineModule({ name: "note", /* ... */ activate() {} });
   ```
   正解：读文件挪进 `activate()`——它有降级护栏（上表第 4 行）。
2. **`activate()` 别挂死**。全内核无超时是既有定案（reload 的 quiesce 等 turn 边界，挂死的等待由用户 Ctrl-C 中止）——你的 activate 永不返回，reload 就一直等。最小反例：`await new Promise(() => {})`。正解：每个 await 都有出路（超时 / 取消信号）。

> 内置模块不享受这层宽容：它们是宿主静态 import，import 期炸等于宿主自己残废（typecheck 门 + 提交纪律兜底）——这也是「转正」（§10）比做外部模块要求高的原因之一。

## 12. 常见坑（都真实踩过或有出处）

1. **"没生效"先查降级**：activate 抛错不崩启动，`--dump-modules` 看状态和原因。
2. **工具/命令命名**：强制 `<module>__<tool>` / `<module>__<cmd>` 前缀，内核校验会拒收。
3. **信任门反复确认**：项目级模块入口内容变了就要重新 trust（hash 机制）；`trust.json` 别手改
   （Windows 盘符大小写有归一逻辑，手改容易踩错）。
4. **promptSection order ≥ 30**：会排到 AGENTS.md 拼尾位之前，与分配表矛盾——领 0–29 的空位。
5. **想"必须注入"结果时有时无**：text 出了空串——空段装配时被过滤；无条件注册 + 永远非空。
6. **工具错误 reject 了**：约定是带内 `isError`（§6.3），reject 会炸整轮回合。
7. **config 读不到**：`defineModule.config` 没声明对应 schema——声明了才有那个节。
8. **外部模块的第三方依赖**：contracts 免装（宿主 alias 钉死），zod 等按 Node 规则向上解析，
   空目录环境自备。
9. **验收纪律**：单测全绿 ≠ 能用。改到 CLI/配置/渲染链路的，收尾前按 developers.md 的
   HERMETIC 配方真实跑一遍。

## 13. 文档地图

| 想干什么 | 去哪 |
|---|---|
| 跟着做一遍模块 | 本文 |
| 查一个口怎么用（签名+示例） | [docs/api](api/README.md)（typedoc，随源码同步） |
| 速查：贡献点/拦截点/错误行为/验收 | [developers.md](developers.md) |
| 机制所以然（为什么这么设计） | [superpowers/specs/2026-09-14-modular-agent-harness-design.md](superpowers/specs/2026-09-14-modular-agent-harness-design.md) |
| 某个模块的设计取舍 | [superpowers/specs/modules/](superpowers/specs/modules/README.md)（一模块一文档） |
| 运行时看装配结果 | `orosus --dump-modules`（= `harness.graph().catalogJson()`） |

## 14. 附：完整 API 参考

> 这一节把模块作者的**全部可用面**列全——每个字段、每个参数、它是干什么的。想读更长的语义注释
> 再去 [docs/api](api/README.md)（typedoc 从 contracts 源码生成），两处内容同源。

### 14.1 defineModule 全字段

```ts
defineModule({ name, version, description, api, dependsOn?, provides?, defaultEnabled?,
               uses?, mounts?, config?, logEvents?, activate(ctx) })
```

| 字段 | 类型 | 必填 | 干什么 |
|---|---|---|---|
| `name` | string | ✓ | 模块名 = 命名空间。kebab-case、全局唯一（规则 4）；工具/命令的 `<module>__` 前缀、日志事件的 `<module>/` 前缀都由它派生 |
| `version` | string | ✓ | 语义版本；`--dump-modules` 的 audit 里可见 |
| `description` | string | ✓ | 一句话说明；清单与 dump 里展示 |
| `api` | number | ✓ | 契约主版本。核心兼容窗口支持 N 与 N-1（§8.5），超窗的模块拒绝加载 |
| `dependsOn` | `Dependency[]` |  | 依赖的能力 key。写法两种：`"fs.read"` = 硬依赖（拓扑序保证 activate 时必有值）；`{ capability: "x", optional: true }` = 可选依赖（不建拓扑边，运行期 `getOptional` 迟到绑定，可能 undefined） |
| `provides` | string[] |  | 自己提供的能力 key 声明。公共短名（如 `fs`）只能用 contracts 登记过的（规则 1），自有的带模块名前缀；`ctx.provide()` 的 key 必须 ⊆ 这里，多给会拒收 |
| `defaultEnabled` | boolean |  | 缺省是否启用（缺省 true）；用户 `module enable/disable` 与 CLI 覆盖在其上 |
| `uses` | string[] |  | 高权限行为自声明：`network` / `subprocess` / `fs.write` / `env` / `secrets` / `config.foreign`（要 overlay 别人配置节必须声明这个）……信任层 L0 只展示、L1 强制、L2 是 RPC 面；**层由来源+用户选择决定，`uses` 不决定层**（§8.5） |
| `mounts` | string[] |  | 允许的挂点白名单，如 `["contribute:tool", "contribute:promptSection"]`；缺省不限制。写上是自我约束 + 审读锚点 |
| `config` | ZodType\<C\> |  | 自家配置节 `[name]` 的 schema。**声明了才有 `ctx.config` / `configRead()`**；配置按纯分层合并（内置 < 用户 < 项目 < CLI）后过 schema 校验、填默认值 |
| `logEvents` | string[] |  | `ctx.session.append()` 的事件类型白名单，必须带 `<module>/` 前缀；没声明的 type 会被拒收 |
| `activate(ctx)` | function | ✓ | 激活入口，启动/reload 的拓扑序里调一次。可返回 `dispose()` 或 `{ dispose }`——模块停用（close / reload 换代 / 回滚）时先于各注册 disposer 调用 |

### 14.2 activate(ctx)——ModuleContext 全口

| 口 | 签名 | 干什么 |
|---|---|---|
| `ctx.config` | `readonly C` | activate 期注入的配置**快照**（已校验、带默认值）；overlay 不作用于它。要活读用 `configRead()` |
| `ctx.configRead()` | `() => Promise<C>` | 运行期读自家配置：复合各模块 overlay 后重新过 owner schema。**activate 期只保证纯分层值**，依赖 overlay 的读取放运行期 |
| `ctx.log` | `Logger` | 五级：`trace/debug/info/warn/error(code, msg, data?)`。code 是稳定事件码（点分路径，如 `my.cache-hit`），实现自动携带模块名；走独立诊断日志旁路，不进模型上下文 |
| `ctx.ui` | `CommandUi` | 宿主注入的交互口（命令处理器第二参也是它）。方法见 13.5 |
| `ctx.llm` | `LlmPort` | 二级 LLM 调用（摘要/标题类）。见 13.6 |
| `ctx.services.get` | `<T>(key) => Promise<T>` | 消费**硬依赖**能力：拓扑序保证 activate 期间必有值，get 不会 undefined |
| `ctx.services.getOptional` | `<T>(key) => Promise<T \| undefined>` | 消费可选能力：调用时解析，可能 undefined（提供方迟到你才读）。消费方必须写回落路径 |
| `ctx.provide` | `(key, impl) => void` | 往能力槽放实现（单所有者槽，先到先得，重复 provide 报错）。key 须 ⊆ `provides` 声明；例外：核心保留槽（如 `provider:<name>`）由核心特许 |
| `ctx.contribute.tool` | `(t: Tool) => Disposer` | 注册模型可调用的工具。见 13.3 |
| `ctx.contribute.command` | `(name, handler) => Disposer` | 注册宿主命令 `/<module>__<name>`。**人用的操作面，模型看不见**。handler `(args: string, ui: CommandUi) => string \| Promise<string>`，args 是命令后的原始参数串 |
| `ctx.contribute.promptSection` | `(s: PromptSection) => Disposer` | 注册系统提示词段。见 13.4 |
| `ctx.contribute.configOverlay` | `(o) => Disposer` | 改**读侧**投影：`{ section?: string, read(value) => value }`，缺省 section = 自家、声明他人 section 须 `uses` 含 `config.foreign`。只作用于 `configRead()`，不作用于 `ctx.config` 快照、不改盘 |
| `ctx.session.append` | `(type, payload) => void` | 写会话日志扩展事件。type 须在 `logEvents` 白名单；payload 是任意 JSON 对象。TUI 投影、回放、别的模块都从这里读 |
| `ctx.session.messages?` | `() => Promise<ModelMessage[]>` | 读当前会话的**模型消息投影**（压缩/裁剪事件已应用，与 agentLoop 同投影）。可选口——非核心宿主可能不提供，消费方必须带回落 |
| `ctx.events.on` | `(type, listener) => Disposer` | 订阅事件。listener 返回 `undefined` = 通过；返回 `{ deny: true, reason }` 或抛错 = 否决（仅拦截点有否决语义，见下表） |
| `ctx.events.emit` | `(type, payload) => Promise<void>` | 模块间通知。**仅限 `<module>/*` 命名空间**，核心事件类型拒绝模块 emit |

### 14.3 defineTool——两阶段工具契约

```ts
defineTool({ name, description, parameters, resolveExecution(input): Promise<ToolExecution> })
```

| 字段 | 干什么 |
|---|---|
| `name` | 强制 `<module>__<tool>` 前缀（规则 4），内核校验拒收违规名 |
| `description` | **进模型的**——写清楚干什么、什么时候用、什么时候别用；模型选不选它全看这段 |
| `parameters` | zod schema。模型传参先过校验，不合 schema 的调用内核直接拒收；`resolveExecution` 拿到的 input 已是合法形状 |
| `resolveExecution(input)` | **阶段一（声明，无副作用）**：看一眼参数，返回本次执行的资源声明与执行闭包。每次调用都会走到，别在这里改状态 |

`ToolExecution`（阶段一返回值）：

| 字段 | 干什么 |
|---|---|
| `accesses?` | 资源访问声明，给并发调度器与审批系统：`[{ kind: "fs.read" \| "fs.write", path }]` / `[{ kind: "network", host }]` / `[{ kind: "subprocess" }]`。**缺省 = `{ kind: "all" }` 独占**（fail-closed：不声明就当你什么都能碰，别的工具给你让路）。助手函数：`Access.fsRead(path)` 等 |
| `approvalRule?` | 审批规则 pattern（数据，如 `"tool-shell__bash(git *)"`）；缺省 = 需要审批（fail-closed）。规则命中与否还经 `matchesRule` 语义判定 |
| `matchesRule?` | `(ruleArgs: string) => boolean`——带参规则的**工具侧语义判定**（比如路径真的在规则允许的目录下）；缺省 = 不匹配任何带参规则 |
| `execute(ctx)` | **阶段二：唯一副作用点**。`ctx: ToolContext` = `{ callId, signal, log }`——callId 关联 tool/call 与 tool/result 日志；signal 是取消信号（长耗时工具必须响应，别硬扛）；log 同 ctx.log |

`ToolResult`（execute 返回值）：

| 字段 | 干什么 |
|---|---|
| `output` | string，模型看到的文本。工具出错**不许 reject**——带内返回 `{ output: 错误说明, isError: true }`（§6.3），reject 会炸整轮回合 |
| `isError` | true = 这次调用失败，模型会看到错误并自行决定重试/放弃 |
| `truncated?` / `spill?` | 输出超限时截断标记 / 落盘文件 `{ path, bytes }`（模型可再读全文） |
| `denied?` | 被 `tool/pre-execute` 瀑布否决时由内核置 true（此时 isError 恒 true）——不是工具自己写的 |

### 14.4 promptSection——系统提示词段

| 字段 | 干什么 |
|---|---|
| `order` | 全局拼接顺序。核心五节概念 -100 永远最前；现有分配表：skill=0、tool-todo=10、mcp=20；AGENTS.md 等价 30 固定拼尾。**新模块领 0–29 的空位**，≥30 会插进 AGENTS.md 前面与分配表矛盾 |
| `text` | string 或 getter。getter 每轮请求装配时求值（活段——todo 面板、mcp 清单都是这么做的）；**空串段装配时被过滤**——「必须注入」类内容应无条件注册且永远非空 |

### 14.5 CommandUi——交互口（命令与审批询问共用）

| 方法 | 干什么 |
|---|---|
| `ask(question)` | 问一个开放问题，返回用户输入 |
| `askSecret(question)` | 同 ask，宿主应以掩码回显（密钥类） |
| `choose(title, items)` | 单选菜单，返回选中项 |
| `confirm(question)` | 是/否确认 |
| `notice?(text)` | 瞬时提示（「已切换」类）：全屏宿主走浮动 toast（3s 自消），行模式落单行。**命令体 notice 后返回空串**（静默约定），别把提示当结果文本返回 |

> 无头环境（`--print`、测试、嵌入式）注入**拒绝式实现**：三问法抛「无交互环境」→ 命令带内失败，fail-closed。所以命令体要能承受 ui 不可用。

### 14.6 LlmPort——二级模型调用

| 成员 | 干什么 |
|---|---|
| `stream(req)` | `req = { system?, messages, signal?, maxTokens? }`，返回 `AsyncIterable<Chunk>`。**复用 harness 当前 provider/model**（含 /model 运行期覆盖）；不带工具；错误带内（`finish{kind:"error"}`），不许 reject |
| `contextWindow` | 当前模型上下文窗口（token），getter 惰性读；未知 undefined |
| `lastUsage` | 最近一次**主循环**请求的真实用量锚点 `{ totalTokens, atMessageCount }`——其后消息用估算增量。仅运行期调用（activate 期 provider 可能未装配） |

### 14.7 事件与拦截点（白名单 8 个，§6.5）

| 拦截点 | 语义 | 典型用途 |
|---|---|---|
| `agent/pre-step` | emit | 每轮开始时的观察/通知 |
| `agent/transform-context` | reduce | 改写发给模型的上下文（压缩模块在此） |
| `agent/steering` | 拦截 | 用户转向插入 |
| `agent/follow-up` | collect | 收集后续动作建议 |
| `agent/should-stop` | 布尔 OR | 任何一方说停就停 |
| `tool/pre-execute` | **waterfall（审批在此）** | 审批门、工具冻结、参数审计 |
| `tool/post-execute` | emit | 执行结果观察（日志/统计） |
| `ui/command` | emit | 命令路由观察 |

返回 `undefined` = 放行；`{ deny: true, reason }` 或抛错 = 否决（仅 waterfall/拦截类有否决语义）。

### 14.8 生命周期速记

- `activate`：拓扑序调用一次；硬依赖在前（§5.2）。
- 一切注册（tool/command/promptSection/events.on…）**返回 Disposer**——模块停用时内核自动逐个调用，不用你记。
- `activate` 返回的 `dispose`：注册之外的清理（句柄/子进程），**先于**各注册 disposer 执行。
- reload 换代：被保留（preserved）的模块不重建、不株连；被换下的走完整拆除。
- **activate 抛错 = 该模块降级，不阻断启动**（§11）；`required = true`（核心模块专属）才阻断。
