# Orosus 模块扩展点目录（机器生成——勿手改）

> 本文件由 `scripts/gen-extension-catalog.mts` 从 `packages/contracts/src/module/index.ts` 生成
> （`pnpm gen-extension-catalog`；docs:check 门禁验同步）。帮用户写模块的 AI 请先读这份目录——
> 每个口子给：一句人话、声明形态、可抄示例。源里没有的口子不存在；缺注释或缺示例的口子过不了门禁。

## 贡献点

### contribute.tool

注册模型可调用的工具（进请求的 tools 数组）。

```ts
tool(t: Tool): Disposer;
```

```ts
ctx.contribute.tool(defineTool({
  name: "note__add",
  description: "Add a short note that persists across turns.",
  parameters: z.object({ text: z.string().min(1) }),
  resolveExecution: async (input) => ({
    accesses: [],
    approvalRule: "note__add",
    execute: async () => ({ output: "Noted", isError: false }),  // 错误带内，不许 reject
  }),
}));
```


### contribute.command

m5 T15：可选第三参——命令参数补全（Tab/参数阶段）。completeArg 收（当前词, 全参数串）返回候选

```ts
command(name: string, handler: CommandHandler, opts?: { completeArg?: (word: string, args: string) => string[] }): Disposer;
```

```ts
ctx.contribute.command("open", async (args) => openNote(args), {
  completeArg: (word) => notes.filter((n) => n.startsWith(word)),
});
```


### contribute.promptSection

注册系统提示词段：order 决定拼接顺序（核心保留 -100；分配表现值 skill=0/todo=10/mcp=20，

```ts
promptSection(s: PromptSection): Disposer;
```

```ts
ctx.contribute.promptSection({
  order: 15,
  get text() { return notes.length === 0 ? "" : `## Notes\n${notes.join("\n")}`; },
});
```


### contribute.configOverlay

配置 overlay（§6.6 读侧扩展，D2）：缺省 section = 自家；声明他人 section 须 uses 含 "config.foreign"。

```ts
configOverlay(o: { section?: string; read(value: unknown): unknown }): Disposer;
```

```ts
ctx.contribute.configOverlay({
  read(value) {
    const v = value as { maxNotes?: number };
    return { ...v, maxNotes: Math.min(v.maxNotes ?? 20, 50) };  // 修饰读侧投影，不落盘
  },
});
```


### contribute.card

投一张常驻卡片进右侧卡片区（m5 口子二）：area 自选 "top"（右上区域，运行状态/网络·MCP 后面）

```ts
card?(spec: CardSpec): Disposer;
```

```ts
ctx.contribute.card({
  area: "bottom",
  order: 50,
  title: "便签",
  get widgets() {
    return notes.length === 0 ? [] : [{ id: "n", kind: "kv", label: "条数", value: String(notes.length) }];
  },
});
```


## 交互 UI

### ui.notice

瞬时提示（2026-09-22 批⑧，可选）：「无可压缩/已切换」类一次性反馈——全屏宿主走浮动 toast（3s 自消），

```ts
notice?(text: string, opts?: { durationMs?: number }): void;
```

```ts
await ui.notice?.("已导出 3 条便签", { durationMs: 8000 }); // 停 8 秒
```


### ui.viewText

弹自己的只读文本窗（m5 口子一，可选）：大小位置经 layout 自定、可绑自定义键。缺省/无头/行模式

```ts
viewText?(title: string, text: string, opts?: { layout?: PopupLayout; keys?: Record<string, PopupKey>; owner?: string }): void;
```

```ts
ui.viewText?.("便签", notes.join("
"), { layout: { height: 20, marginTop: 2 } });
```


### ui.insertText

往主输入框光标位插入文本（m5 附带能力 3，可选）：与用户手打等效（可退格删除）。行模式/无头静默丢弃

```ts
readonly insertText?: ((text: string) => void) | undefined;
```

```ts
ui.insertText?.("已填入模板");
```


### ui.attachImage

贴一张图进输入框（m5 附带能力 3，可选）：chip 形态 [image #N]，随发送上传。路径不存在时黄字提示。

```ts
readonly attachImage?: ((path: string) => void) | undefined;
```

```ts
ui.attachImage?.("D:/shots/2026-09-25.png"); // chip [image #N] 进输入框
```


### ui.dialog

控件窗（m5 口子三，可选）：交控件清单宿主代画，用户操作变事件回传。返回句柄可 update(新清单)/close()；

```ts
readonly dialog?: ((spec: DialogSpec) => DialogHandle | undefined) | undefined;
```

```ts
const h = ui.dialog?.({ title: "作业", widgets: [{ id: "p", kind: "progress", value: () => done, max: total }] });
 // 完成后：h?.close()
```


## 读面与设置

### ctx.settings

宿主设置服务（m5 口子四，可选直挂）：全屏宿主提供 SettingsService；老宿主/无头 = undefined，

```ts
readonly settings?: SettingsService | undefined;
```

```ts
await ctx.settings?.setEffort("high");   // 判空调用：没装就静默跳过
```


### ctx.host

宿主状态读面（m5 口子四读侧，可选）：ctx.host.current() 拿运行值快照（模型/力度/挂载模式/权限/用量）。

```ts
readonly host?: HostInfo | undefined;
```

```ts
const snap = await ctx.host?.current();
if (snap) ctx.log.info("note.host", "当前模型", { model: snap.model, preset: snap.preset });
```


## 基础设施

### events.on / events.emit

订阅事件；拦截点返回 { deny: true, reason } 或抛错 = 否决（waterfall 语义，§6.5 白名单 8 个）。

```ts
on(type: string, listener: Listener): Disposer;
```

```ts
ctx.events.on("tool/pre-execute", (p) => {
  const { name } = p as { name: string };
  if (name === "note__add") return { deny: true, reason: "便签功能已冻结" };
  return undefined;   // undefined = 通过
});
```


### session.append / session.messages

写会话日志扩展事件；type 须已在 logEvents 声明（白名单）。

```ts
append(type: string, payload: Record<string, unknown>): void;
```

```ts
// defineModule 里先声明：logEvents: ["note/write"]
ctx.session.append("note/write", { notes });
```


### services.get / provide

提供能力实现（单所有者槽）；key 须 ⊆ 声明区 provides（唯一例外：核心保留槽 key）。

```ts
provide(key: string, impl: unknown): void;
```

```ts
ctx.provide("my-module.store", { get: () => value, set: (v) => { value = v; } });
// 消费方（另一模块）经 dependsOn: ["my-module.store"] + ctx.services.get 解析
```

