# module 域 API 参考

> 模块 API 主面——defineModule、ModuleContext 全口（工具/命令/提示词段/卡片）、CommandUi 交互（弹窗/控件窗/注入）、LlmPort、SettingsService 与 HostInfo 读面、事件与信任门语义。
> 本文件由 `scripts/gen-api-docs.mts` 从 contracts 源生成（`pnpm gen-docs`，docs:check 门禁验同步）——
> 注释、@param（含义+范围）、@example 与源码同源；发现缺口门禁会红。

## MODULE_API_VERSION（常量）

核心模块 API 主版本。核心按主版本做兼容检查（支持 N 与 N-1，见设计 §8.5）。

```ts
export const MODULE_API_VERSION = 1
```

## Disposer（类型）

注册即返回的注销句柄（规则 3：一切注册返回 disposer）。

```ts
export type Disposer = () => void | Promise<void>
```

## Logger（接口）

模块级诊断 logger（§11.9）——Ctrl + E 诊断弹窗与诊断日志的数据源。五个方法只是级别不同，形状一致。

```ts
export interface Logger { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `trace` | `trace(code: string, msg: string, data?: Record<string, unknown>): void` | 最细粒度跟踪（通常不落盘——级别开关在宿主）。 |
| `debug` | `debug(code: string, msg: string, data?: Record<string, unknown>): void` | 调试细节（开发期排查用）。 |
| `info` | `info(code: string, msg: string, data?: Record<string, unknown>): void` | 常规信息（模块激活/正常状态变迁）。 |
| `warn` | `warn(code: string, msg: string, data?: Record<string, unknown>): void` | 异常但已降级处理（本模块功能受影响，不影响别人）。 |
| `error` | `error(code: string, msg: string, data?: Record<string, unknown>): void` | 错误（本模块功能不可用）。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `trace · debug · info · warn · error` | `code` | 稳定事件码，点分路径（约定 `<模块名>.<事件>`，如 "note.write"）；只进日志不做 i18n。 |
| `trace · debug · info · warn · error` | `msg` | 人话一句话（中文）；模块名由实现自动携带，不用自己写。 |
| `trace · debug · info · warn · error` | `data` | 附带数据键值对；小体量事实（计数/路径/错误串），单条 ≤ 2KB。 |

**示例**

```ts
ctx.log.warn("note.overflow", "便签超上限被裁剪", { kept: 20, dropped: 3 });
```

## CapabilityKey（类型）

能力 key 的品牌类型——公共短名只能由 contracts 包定义（规则 1）。

```ts
export type CapabilityKey<T> = string & { readonly __capability?: T }
```

## CommandHandler（类型）

斜杠命令处理器：/<module>__<command>。第二参 ui 为宿主注入的交互抽象（D35）——纯函数命令可忽略。

```ts
export type CommandHandler = (args: string, ui: CommandUi) => Promise<string> | string
```

## PopupLayout（类型）

弹窗布局（m5 口子一/三共用）：预设名或自定义数字。
预设两个——"center80"（占窗 80% 居中，缺省值）与 "full"（全屏）。自定义形态：width/height 为
百分比串（"80%"）或固定格数（数字），四边距（marginStart/End/Top/Bottom）从对应边往中间推，
对边同给 = 居中。非法值（负数边距、百分比出界、装不进终端）整体回退 "center80" 重算——
连 center80 都装不下时调用方不弹窗、黄字提示「终端窗口太小」。

```ts
export type PopupLayout =
```

**示例**

```ts
ui.viewText?.("便签", text, { layout: { height: 20, marginTop: 2, marginStart: 4 } });
```

## PopupKey（接口）

弹窗自定义键：键名用 keymatch 规范化名（"r"、"alt+r"、"pageUp"）。绝对禁绑 = Esc、Ctrl+C/V/A/S/Z
与宿主全局键（Ctrl+T/E/O 等）——注册即拒并记模块日志。run 三种返回：返回字符串 = 窗内容整体替换
并滚回顶部（其中字符串恰为 "close" = 关窗）；无返回 = 内容不动。

```ts
export interface PopupKey { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `label` | `label: string` | 键位显示名（窗底部提示行展示，如「刷新」）；空串也合法（不显示）。 |
| `run` | `run(): string \| "close" \| void` | 按键动作。返回字符串 = 窗内容整体替换并滚回顶部；恰好返回 "close" = 关窗；无返回 = 内容不动。抛错 = 黄字提示且窗保留。 |
**示例**

```ts
ui.viewText?.("便签", notes.join("\n"), {
  keys: { "alt+r": { label: "刷新", run: () => notes.join("\n") } },
});
```

## CommandUi（接口）

命令交互 UI 抽象（D35）：ask/choose/confirm——宿主注入 readline 实现；无头环境注入拒绝式
（三方法抛"无交互环境"→ 命令带内失败，fail-closed）。多级菜单 = 命令内嵌套调用。
命令交互 UI 抽象（D35）：命令处理器第二参 + waterfall 监听者共用。宿主注入实现——
全屏 = 浮层/接管输入行；行模式 = readline；无头 = 拒绝式（核心四法抛"无交互环境"，fail-closed；
m5 可选口缺省不存在，判空降级）。Esc 取消统一映射「已取消（Esc）」带内抛错穿透处理器。

```ts
export interface CommandUi { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `ask` | `ask(question: string): Promise<string>` | 问一句（自由文本）。 |
| `askSecret` | `askSecret(question: string): Promise<string>` | 敏感输入（密钥等）：语义同 ask，宿主以静默盲输/掩码回显。 |
| `choose` | `choose(title: string, items: string[]): Promise<string>` | 列表单选（≥12 项宿主自动带输入过滤）。 |
| `confirm` | `confirm(question: string): Promise<boolean>` | 是/否确认。 |
| `notice?` | `notice?(text: string, opts?: { durationMs?: number }): void` | 瞬时提示（2026-09-22 批⑧，可选）：「无可压缩/已切换」类一次性反馈——全屏宿主走浮动 toast（3s 自消）， 行模式宿主落单行。命令体应 notice(...) 后返回空串（静默约定），而不是把提示当结果文本返回。 缺省/无头实现可静默丢弃——notice 是增强反馈，不承载命令语义。 m5 扩第二可选参（时长毫秒）：缺省 3000，允许范围 [1000, 30000]，越界按边界值算——不传即缺省， 主程序自己的提示全走缺省零变化。 |
| `viewText?` | `viewText?(title: string, text: string, opts?: { layout?: PopupLayout; keys?: Record<string, PopupKey>; owner?: string }): void` | 弹自己的只读文本窗（m5 口子一，可选）：大小位置经 layout 自定、可绑自定义键。缺省/无头/行模式 静默丢弃。窗排队（一次一窗，后来的等旧窗关）。 opts.owner 是内核包装层自动标注的模块名（宿主内建调用 = undefined）——「模块卸载关它的窗」的 属主判定靠它；模块开发者无须也不应自填（@internal）。 |
| `insertText?` | `readonly insertText?: ((text: string) => void) \| undefined` | 往主输入框光标位插入文本（m5 附带能力 3，可选）：与用户手打等效（可退格删除）。行模式/无头静默丢弃 （读出来是 undefined——CLI 实现是活 getter，随全屏/行模式切换存在性）。 |
| `attachImage?` | `readonly attachImage?: ((path: string) => void) \| undefined` | 贴一张图进输入框（m5 附带能力 3，可选）：chip 形态 [image #N]，随发送上传。路径不存在时黄字提示。 行模式无文内 chip 机制——读出来是 undefined（同 insertText 活 getter）。 |
| `dialog?` | `readonly dialog?: ((spec: DialogSpec) => DialogHandle \| undefined) \| undefined` | 控件窗（m5 口子三，可选）：交控件清单宿主代画，用户操作变事件回传。返回句柄可 update(新清单)/close()； 不支持控件窗的宿主（行模式/无头）返回 undefined——模块须判空降级（如回退 viewText）。 属性式 \| undefined：CLI 实现是活 getter（随全屏/行模式切换存在性，同 insertText）。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `ask` | `question` | 提示语（人话一句话；宿主负责渲染与回显）。 |
| `askSecret` | `question` | 提示语。 |
| `choose` | `title` | 标题（显示在浮层头）。 |
| `choose` | `items` | 候选清单（每项单行文本——多行项宿主压平；中文/emoji 可）。 |
| `confirm` | `question` | 问句（宿主显示为 `question [y/N]` 形态）。 |
| `notice` | `text` | 提示文本（单行语义；过长宿主折行 ≤ 3 行）。 |
| `notice · viewText` | `opts` | 可选项。 |
| `notice` | `opts.durationMs` | 停留毫秒；缺省 3000，范围 [1000, 30000]，越界钳到边界。不传 = 缺省。 |
| `viewText` | `title` | 窗标题（顶框展示；单行）。 |
| `viewText` | `text` | 正文（\n 分行；可含宿主题色语义串——宿主按看得见的宽度折行/截断，不许夹终端控制码）。 |
| `viewText` | `opts.layout` | 布局；缺省 "center80"。非法值整体回退 center80；终端装不下 = 不弹 + 黄字。 |
| `viewText` | `opts.keys` | 自定义键（键名 → 动作）；键名用 keymatch 规范名（"r"、"alt+r"、"pageUp"），保留键注册即拒。 |
| `viewText` | `opts.owner` | 内核自动标注的模块名（@internal——模块勿自填）。 |
| `insertText` | `text` | 插入文本（与用户手打等效——可退格删除；多行文本宿主按编辑器规则并入）。 |
| `attachImage` | `path` | 图片文件绝对路径（PNG/JPEG/WebP/GIF）；不存在 = 黄字提示；随下一条消息发送（需 vision 模型）。 |
| `dialog` | `spec` | 控件窗清单（标题 + widgets 开窗快照 + onEvent 回传 + 可选布局）。owner 由内核标注（@internal）。 |

**示例**

```ts
const name = await ui.choose("选一条便签", notes);
await ui.notice?.(`已选中：${name}`);
```

## WidgetSpec（类型）

控件（m5 口子二/三共用）——「给数据不给画面」：模块交控件清单，画永远是宿主画。八种：
text 一段文字（可带样式与折行开关）/ kv 一行「标签: 值」/ sep 分隔线 / list 列表（interactive =
可选中，选中变化回事件）/ progress 进度条（value/max）/ input 输入框（multiline 多行、lines 高度、
enterSubmit 回车即提交）/ columns 多列（cols 每列又是控件清单，可嵌套）/ table 表格。
text/value/progress 的 value 字段给函数 = 活值：宿主渲染期现读（卡片每秒、控件窗每帧）。

```ts
export type WidgetSpec =
```

**示例**

```ts
const widgets: WidgetSpec[] = [
  { id: "head", kind: "text", text: "后台作业", style: "accent" },
  { id: "p", kind: "progress", value: () => done / total, max: 1 },
];
```

## DialogEvent（类型）

控件窗事件三型：input（输入框内容变化，每键一回）/ select（可交互列表选中变化）/ activate（回车激活——
列表带 index，输入框不带）。每按一次键立刻回传事件并整窗重画（不防抖——窗小重画便宜，攒着反而迟钝）。

```ts
export type DialogEvent =
```

## DialogSpec（接口）

控件窗清单（m5 口子三）。widgets 是开窗快照（静态清单直接给；活值走字段级函数或 update 句柄——
整份清单「现问现答」是卡片专属，dialog 有 update 句柄不需要）。onEvent 返回新清单 = 整窗替换并滚回顶部；
返回 undefined = 不动。

```ts
export interface DialogSpec { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `title` | `title: string` | 窗标题（顶框展示；单行）。 |
| `layout?` | `layout?: PopupLayout` | 弹窗布局；缺省 "center80"。 |
| `widgets` | `widgets: WidgetSpec[]` | 开窗快照（静态清单直接给；活值走字段级函数或 update 句柄——整份清单现问现答是卡片专属）。 |
| `onEvent?` | `onEvent?(e: DialogEvent): WidgetSpec[] \| void` | 用户操作回传（每键立即一回，不防拖）。 |
| `owner?` | `owner?: string` | 内核包装层自动标注的模块名（宿主内建调用 = undefined）——「模块卸载关它的窗」属主判定用（@internal，模块勿自填）。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `onEvent` | `e` | 事件（input/select/activate 三型，见 DialogEvent）。 |

**示例**

```ts
const h = ui.dialog?.({
  title: "作业",
  widgets: [{ id: "p", kind: "progress", value: () => done, max: total }],
});
// 完成后：h?.close()
```

## DialogHandle（接口）

控件窗句柄：update 换整份清单（滚回顶部）；close 关窗。窗已关或模块已卸载后再调 = 无操作不报错。

```ts
export interface DialogHandle { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `update` | `update(widgets: WidgetSpec[]): void` | 换整份清单（滚回顶部）。 |
| `close` | `close(): void` | 关窗。窗已关/模块已卸载后调用 = 静默无操作不报错。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `update` | `widgets` | 新控件清单（与开窗参数同形状）。 |

**示例**

```ts
const h = ui.dialog?.({ title: "作业", widgets });
later(() => h?.update(newWidgets)); // 异步完成推新清单
h?.close();
```

## CardSpec（接口）

卡片清单（m5 口子二）。widgets 建议用 getter——宿主每秒重读，模块侧改个变量卡片就自己跳。

```ts
export interface CardSpec { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `area` | `area: "top" \| "bottom"` | 投哪个区：top = 右上（运行状态、网络·MCP 后面）；bottom = 右下（任务清单后面）。模块自选，宿主不分配。 |
| `order` | `order: number` | 同区内排序：内建卡恒在前，模块卡按此值升序排后；建议 40–990（别越核心保留段）。 |
| `title` | `title: string` | 卡标题（卡框头展示；单行）。 |
| `widgets` | `readonly widgets: WidgetSpec[]` | getter 现问现答，宿主每秒重读；抛错 = 当帧剔除该卡 + 模块日志 warn。 |
**示例**

```ts
ctx.contribute.card?.({
  area: "bottom", order: 50, title: "便签",
  get widgets() { return [{ id: "n", kind: "kv", label: "条数", value: String(notes.length) }]; },
});
```

## LlmPort（接口）

二级 LLM 调用口（D39）：模块的辅助模型调用（compaction 摘要、标题生成等）。
复用 harness 当前 provider/model 解析（含 /model 运行期覆盖）；错误带内（finish error，不许 reject）；
二级调用不带客户端工具（M4-3 T1b 修订：webSearch 声明的是服务端搜索，不是 tools——模型不可见、不进会话）。
核心基础设施（与 ctx.log/session 同类）——不是能力槽、不经 services、不可 provide 替换。
M3 补强三扩展（D39 修订）：stream 增可选 maxTokens（输出上限）；contextWindow/lastUsage 只读事实，getter 惰性读 holder。
M4-3 T1b 扩展（SW-17）：stream 增可选 model（缺省 = 当前模型；支持 provider/model 限定形——钉非当前提供商的
模型时用）与 webSearch（声明服务端原生搜索）；LlmPort 增可选 listModels（模型目录——缺省 undefined = 目录不可用，
菜单据此灰显模型选择；条目统一 provider/model 限定形，跨槽聚合）。

```ts
export interface LlmPort { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `stream` | `stream(req: { system?: string; messages: ModelMessage[]; signal?: AbortSignal; maxTokens?: number; model?: string; webSearch?: boolean }): AsyncIterable<Chunk>` | 二级流式调用（错误带内——finish error，不许 reject）。 |
| `listModels?` | `listModels?: (() => Promise<string[]>) \| undefined` | 模型目录（SW-17）：跨 provider 槽聚合的可用模型（条目统一 `provider/model` 限定形——钉选值同款格式）。 可选——无一槽提供目录能力时读得 undefined（显式 \| undefined：exactOptionalPropertyTypes 下 getter 惰性判定合法）， 消费方据此隐藏模型选择项。 |
| `contextWindow?` | `readonly contextWindow?: number \| undefined` | 当前模型上下文窗口（token）——harness 解析（config 顶层 contextWindow > provider import 目录写入）；未知 undefined。 |
| `lastUsage?` | `readonly lastUsage?: { totalTokens: number; atMessageCount: number } \| undefined` | 最近一次主循环请求的真实用量锚点：totalTokens = input+output（该次请求全上下文）、atMessageCount = 该次请求 messages 条数——其后消息用估算增量（compaction 消费；锚点有效性三态规则见 M3 补强方案空白 §4）。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `stream` | `req` | 请求体。 |
| `stream` | `req.system` | 系统提示词（可省）。 |
| `stream` | `req.messages` | 对话消息（ModelMessage 形状）。 |
| `stream` | `req.signal` | 取消信号（中断流；可省）。 |
| `stream` | `req.maxTokens` | 输出上限 token 数（正整数；可省 = 不限）。 |
| `stream` | `req.model` | 钉非当前提供商的模型时用（"provider/model" 限定形；可省 = 当前模型）。 |
| `stream` | `req.webSearch` | 声明服务端原生搜索（端点不支持时被忽略；可省）。 |

**示例**

```ts
// 二级调用：摘要生成（compaction 同款形态）——仅运行期调用，activate 期 provider 可能未装配
let text = "";
for await (const c of ctx.llm.stream({ system: "你是摘要器", messages, maxTokens: 2048 })) {
  if (c.type === "text/delta") text += c.text;
  if (c.type === "finish" && c.kind === "error") { text = ""; break; }  // 错误带内，不许 reject
}
```

## PromptSection（接口）

系统 prompt 段：order 决定拼接顺序（核心保留 -100 为 harness 身份），单段 ≤ 32KB。

```ts
export interface PromptSection { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `order` | `order: number` | 拼接序：核心保留 ≤ -100；模块分配表 skill=0 / todo=10 / mcp=20，新段领 0–29 空位且保持 < 30（≥ 30 会插到 AGENTS.md 前与分配表矛盾）。 |
| `text` | `text: string` | 段正文（单段 ≤ 32KB，全局合计 ≤ 64KB）；getter 时每轮装配现读；空串段装配时被过滤。 |
**示例**

```ts
ctx.contribute.promptSection({ order: 15, get text() { return notes.length === 0 ? "" : `## Notes`; } });
```

## Listener（类型）

事件监听者。waterfall 拦截点上：返回 undefined = 通过；返回 { deny: true, reason } 或抛错 = 否决。

```ts
export type Listener = (payload: unknown) => unknown | Promise<unknown>
```

## Dependency（类型）

依赖声明：字符串 = 硬依赖；{ capability, optional: true } = 可选依赖（不建拓扑边）。

```ts
export type Dependency = string | { capability: string; optional?: boolean }
```

## SettingsService（接口）

宿主设置服务（m5 口子四）——「写」面：改模型、改思考力度、切挂载预设、改会话名、开关侧栏、切主题。
ctx.settings 可选直挂（决策点 18）：全屏宿主装、老宿主/无头 = undefined（模块判空降级）。
声明了 mounts 的模块须列 "settings" 才可调（allows 白名单）；读运行值不走它——看 ctx.host。
错误口径：setModel/setEffort/setLabel 等单值写失败 = Promise reject（模块自行 catch 提示）；
applyModulePreset 批量写 = 带内返回失败清单（决策点 21：全部尝试完再统一 reload 一次）。

```ts
export interface SettingsService { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `setModel` | `setModel(qualified: string): Promise<void>` |  |
| `setEffort` | `setEffort(level: string): Promise<void>` |  |
| `setTheme` | `setTheme(name: string): Promise<void>` |  |
| `applyModulePreset` | `applyModulePreset(preset: "full" \| "minimal"): Promise<{ failed: string[] }>` |  |
| `setLabel` | `setLabel(label: string): Promise<void>` |  |
| `setSidebar?` | `setSidebar?(visible: boolean): Promise<void>` |  |
| `readClipboard?` | `readClipboard?(): Promise<string \| undefined>` | 读剪贴板文本。可选——剪贴板通道平台相关，宿主不支持就不装（模块判空降级）。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `setModel` | `qualified` | 模型全形 "provider/model"（提供商名与模型名斜杠分隔；必须是已配置的提供商名，未知名 reject）。 |
| `setEffort` | `level` | 档位名（小写字母数字与 . _ -；目录外模型原样发送不校验；"auto" = 回目录默认档）。 |
| `setTheme` | `name` | 主题名（未知名 reject——错误带外，模块自行 catch）。 |
| `applyModulePreset` | `preset` | "minimal" = 只留核心 + 审批 + 当前活跃 provider；"full" = 恢复极简模式自己关掉的那批（从未切过 = 无操作）。 |
| `setLabel` | `label` | 会话名（截至 200 字符；空串合法 = 清名回未命名）。 |
| `setSidebar` | `visible` | true = 显示右侧面板；false = 隐藏（Ctrl+T 同款，持久化；行模式宿主未装本口）。 |

**示例**

```ts
if (ctx.settings) {
  await ctx.settings.setModel("zhipuai/glm-4.7");   // 换模型（/model 同源写路径）
  const { failed } = await ctx.settings.applyModulePreset("minimal");  // 极简模式
  if (failed.length > 0) ctx.log.warn("note.preset", "部分模块写盘失败", { failed });
}
```

## HostSnapshot（接口）

宿主状态快照（m5 口子四读面，决策点 24）——current() 一次拿全，不分逐字段 get（照 h.status() 先例）。
异步：权限/会话名/用量是事件投影，要翻一次历史。busy 不在快照里——走 ctx.events.on("turn/start"/"turn/end") 自推。
故意不给三件：终端尺寸（布局是宿主的事）、输入框当前内容（insertText 是写口，读回 = 偷用户输入）、
屏幕缓冲/渲染态（渲染权铁律）。

```ts
export interface HostSnapshot { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `model` | `model: string` | 当前模型（qualified 全形，如 "zhipuai/glm-4.7"）与是否运行期覆盖（false = 配置原样）。 |
| `modelOverridden` | `modelOverridden: boolean` | 是否运行期覆盖（false = 配置原样，true = 本次会话内 /model 或设置服务改过）。 |
| `effort?` | `effort?: string \| undefined` | 当前思考档位；未设 = undefined（跟随模型目录默认档）。 |
| `preset` | `preset: "full" \| "minimal" \| "custom"` | 挂载模式现算三态：启用集 ⊆ 保底名单 → "minimal"；全启用 → "full"；其余 → "custom" （现算不靠记忆——用户切完极简又手动插拔，「上次切的档」会撒谎，现算永远诚实）。 |
| `theme` | `theme: string` | 当前主题名（本批仓内仅一套 = 恒 "连山"；主题注册表落地后读 active 名）。 |
| `permission` | `permission: string` | 权限模式（approval/policy 投影——面板运行状态卡同款算法）。 |
| `sessionLabel?` | `sessionLabel?: string \| undefined` | 会话名；未命名 = undefined（显示侧自定「新会话」或 sid）。 |
| `sidebar?` | `sidebar?: boolean \| undefined` | 侧栏可见性；行模式宿主无侧栏 = undefined。 |
| `contextWindow?` | `contextWindow?: number \| undefined` | 上下文窗口 token 数；未知 = undefined（与 ctx.llm.contextWindow 契约口同源）。 |
| `usage` | `usage: {` | token 用量：current = 本会话；lifetime = 全量（可能缺）。 |
**示例**

```ts
const snap = await ctx.host?.current();
if (snap) ctx.log.info("note.host", "当前状态", { model: snap.model, preset: snap.preset });
```

## HostInfo（接口）

宿主状态读面（m5 口子四读侧）——「问宿主」独立命名空间：不占 mounts "settings" 写闸、零声明摩擦
（照 ctx.session.messages?() 无闸读口先例）。无订阅机制：要新值再调一次 current()；喂卡片等同步
getter 的标准接法 = 模块自己缓存（activate 拉首份 + turn 事件刷新，getter 读缓存）。

```ts
export interface HostInfo { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `current` | `current(): Promise<HostSnapshot>` | 拿当前快照（无订阅机制——要新值再调一次；善个异步事件投影）。返回 Promise；同步 getter 的标准接法 = 模块自己缓存。 |
**示例**

```ts
let snap: HostSnapshot | undefined;
ctx.host?.current().then((s) => { snap = s; });              // activate 拉首份
ctx.events.on("turn/end", () => { ctx.host?.current().then((s) => { snap = s; }); });  // 事件刷新
// 卡片 getter 读缓存（同步）：
ctx.contribute.card({ area: "top", order: 60, title: "状态",
  get widgets() { return snap ? [{ id: "m", kind: "kv", label: "模型", value: snap!.model }] : []; } });
```

## ModuleContext（接口）

模块唯一的运行时 API 面（§5.1）。L1/L2 下由宿主换成收窄版，模块代码零改动。

```ts
export interface ModuleContext<C = unknown> { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `config` | `readonly config: C` | activate 时注入的纯分层合并快照（已校验、带默认值；overlay 不作用于它）。 |
| `configRead` | `configRead(): Promise<C>` | 运行期读取自身配置（无 section 参数——只能读自己的 section）。 |
| `log` | `readonly log: Logger` | 诊断日志（五级别同形状；码表纪律见 Logger）。 |
| `ui` | `readonly ui: CommandUi` | 宿主注入的交互 UI（D35 M3 修订/T2）：命令处理器第二参之外，waterfall 监听者（审批询问）同样需要询问口。 无头环境为拒绝式实现（三方法抛"无交互环境"）——waterfall 监听者抛错即否决，fail-closed 方向正确。 |
| `llm` | `readonly llm: LlmPort` | 二级 LLM 调用口（D39）：运行期调用时解析当前 provider/model（activate 期经惰性 holder 注入）。 compaction 摘要等消费方应仅在运行期调用（activate 期 provider 可能尚未装配）。 |
| `services` | `readonly services: {` | 能力解析（硬依赖 get／可选 getOptional——迟到绑定，判空降级）。 |
| `provide` | `provide(key: string, impl: unknown): void` | 挂能力实现（单所有者槽）。 |
| `contribute` | `readonly contribute: {` | 贡献面（工具/命令/提示词段/配置修饰/卡片——都返 Disposer；声明了 mounts 须列 "contribute:*" 位）。 |
| `session` | `readonly session: {` | 会话面（append 落日志、messages 冷投影读口、id 会话标识）。 |
| `tools` | `readonly tools: {` | 工具注册表缝（M4-3 T4/D6——ToolSearch 机制的唯一模块通道；对标宿主活写口 h.setLabel 先例： contracts 加缝 + kernel 接线 + mounts 权限位校验）。模块声明 mounts "tools.reveal"/"tools.list" 后可用 （allows() 模式同 contribute:*；声明了 mounts 而未列位 → 调用即抛）。 |
| `events` | `readonly events: {` | 事件总线（on 订阅 / emit 自有命名空间；声明了 mounts 须列 "hook:<事件>" 与 "emit" 位）。 |
| `settings?` | `readonly settings?: SettingsService \| undefined` | 宿主设置服务（m5 口子四，可选直挂）：全屏宿主提供 SettingsService；老宿主/无头 = undefined， 模块判空降级。声明了 mounts 的模块须列 "settings" 才可调（allows 白名单）。 |
| `host?` | `readonly host?: HostInfo \| undefined` | 宿主状态读面（m5 口子四读侧，可选）：ctx.host.current() 拿运行值快照（模型/力度/挂载模式/权限/用量）。 读不占 mounts 写闸——零声明摩擦（决策点 24）；无 = undefined 判空降级。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `provide` | `key` | 能力 key；必须 ⊆ provides 声明（唯一例外 = 核心保留槽）；建议 `<模块名>.<能力>`。 |
| `provide` | `impl` | 实现对象（消费方自行声明接口形状）。 |

**示例**

```ts
activate(ctx) {
  const { maxNotes } = await ctx.configRead();
  ctx.contribute.tool(myTool);
  ctx.ui.notice?.("note 已就绪");
}
```

## ModuleDefinition（接口）

模块定义（§5.1 完整形态）。声明式：activate 之前全部静态信息可读。

```ts
export interface ModuleDefinition<C = unknown> { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `name` | `name: string` | 模块名（kebab-case，全局唯一——重名降级；工具/命令名前缀也用它）。 |
| `version` | `version: string` | 版本号（semver形如 "0.1.0"；诊断面与审计展示）。 |
| `description` | `description: string` | 一句话描述（人话——面板/帮助里给用户看）。 |
| `api` | `api: number` | 契约主版本（恰为 MODULE_API_VERSION＝1；不匹配拒载）。 |
| `dependsOn?` | `dependsOn?: Dependency[]` | 依赖声明（字符串 = 硬依赖；{ capability, optional: true } = 可选不建拓扑边；可省 = 无）。 |
| `provides?` | `provides?: string[]` | 自己提供的能力 key 清单（ctx.provide 的合法域；建议 `<模块名>.<能力>`；可省）。 |
| `defaultEnabled?` | `defaultEnabled?: boolean` | 缺省启用与否（缺省 true；配置 [模块名] enabled 可覆盖）。 |
| `uses?` | `uses?: string[]` | 声明使用的非能力标记（如 "config.foreign" = 要 overlay 别人 section；可省）。 |
| `mounts?` | `mounts?: string[]` | 宿主口白名单（一经声明 = 只能用列出的口；缺省 = 不限制）。可用位："settings"、"contribute:tool"、"contribute:command"、"contribute:promptSection"、"contribute:configOverlay"、"contribute:card"、"tools.reveal"、"tools.list"、"emit"、"hook:<事件名>"、"provide"、"get"。 |
| `config?` | `config?: ZodType<C>` | 自家配置节的 zod schema（声明了才读得到 [模块名] 节；校验带默认值；可省）。 |
| `logEvents?` | `logEvents?: string[]` | session.append 的事件类型白名单（未列的类型调用即抛；可省）。 |
| `activate` | `activate(ctx: ModuleContext<C>): void \| { dispose?: Disposer } \| Promise<void \| { dispose?: Disposer }>` | 激活体（拓扑序调用一次；抛错 = 模块降级不阻断启动）。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `activate` | `ctx` | 模块上下文（见 ModuleContext；注册/订阅/服务都在这里；activate 期 provider 可能未装酅——llm 只在运行期调）。 |

**示例**

```ts
export default defineModule({
  name: "note", version: "0.1.0", description: "会话便签", api: 1,
  logEvents: ["note/write"],
  activate(ctx) { ctx.contribute.tool(myTool); },
});
```

## defineModule（函数）

身份函数：仅做类型收窄与作者意图标注，不做运行期处理（校验在 kernel，§4.2 第 4 步）。

```ts
export function defineModule<C>(def: ModuleDefinition<C>): ModuleDefinition<C>;
```

**参数**

| 名 | 说明 |
|---|---|
| `def` | 模块定义（字段逐个的含义与范围见 ModuleDefinition；建议配合 zod schema 与 logEvents 白名单）。 |

**返回**：原定义对象（类型收窄 + 意图标注，不做运行期处理）。

**示例**

```ts
export default defineModule({
  name: "note",                     // kebab-case，全局唯一（规则 4）
  version: "0.1.0",
  description: "会话便签——模型跨轮次的临时记事本",
  api: 1,
  config: z.object({ maxNotes: z.number().int().default(20) }),
  logEvents: ["note/write"],        // session.append 的白名单
  activate(ctx) {
    ctx.contribute.tool(myTool);
    ctx.contribute.promptSection({ order: 15, get text() { return "## Notes\n..."; } });
  },
});
```
