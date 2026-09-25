# tool 域 API 参考

> 工具契约——defineTool 两阶段（resolveExecution 声明 / execute 副作用）、Access 资源声明、审批规则与结果形状。
> 本文件由 `scripts/gen-api-docs.mts` 从 contracts 源生成（`pnpm gen-docs`，docs:check 门禁验同步）——
> 注释、@param（含义+范围）、@example 与源码同源；发现缺口门禁会红。

## Access（类型）

单次工具调用的资源访问声明（§6.3）：给并发调度器与审批系统。缺省 = { kind: "all" }（独占）。
四形态：文件读（fs.read + path）/文件写（fs.write + path）/网络（network + host）/子进程（subprocess）。

```ts
export type Access =
```

**示例**

```ts
// 读一个文件 + 访一个域名
accesses: [Access.fsRead("/tmp/a.txt"), Access.network("api.example.com")]
```

## Access（常量）

Access 四形态的便捷构造器（与上方联合类型同名导出。

```ts
export const Access =
```

## ToolResult（接口）

工具结果统一形状（§6.3）。denied: true 表示被 waterfall 否决（此时 isError 恒为 true）。

```ts
export interface ToolResult { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `output` | `output: string` |  |
| `isError` | `isError: boolean` |  |
| `truncated?` | `truncated?: boolean` |  |
| `spill?` | `spill?: { path: string; bytes: number }` |  |
| `denied?` | `denied?: boolean` |  |
## ToolContext（接口）

工具执行期上下文。signal 供取消传播（长耗时工具必须响应）；callId 关联 tool/call 与 tool/result。

```ts
export interface ToolContext { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `callId` | `callId: string` |  |
| `signal` | `signal: AbortSignal` |  |
| `log` | `log: Logger` |  |
## ToolExecution（接口）

阶段一产出：声明（无副作用）+ 执行闭包（唯一产生副作用的环节）。

```ts
export interface ToolExecution { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `accesses?` | `accesses?: Access[]` |  |
| `approvalRule?` | `approvalRule?: string` | 审批规则 pattern（数据），如 "tool-shell__bash(rm -rf*)"；缺省 = 需要审批（fail-closed）。 |
| `matchesRule?` | `matchesRule?: (ruleArgs: string) => boolean` | 规则参数的工具侧语义判定；缺省 = 不匹配任何带参规则（fail-closed）。 |
| `execute` | `execute(ctx: ToolContext): Promise<ToolResult>` | 执行（唯一副作用点）。错误带内——不许 reject，返回 { output, isError: true }。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `matchesRule` | `ruleArgs` | 审批规则后括号内的参数串（如 "rm -rf*"）；返回 true = 本次调用匹配该规则。 |
| `execute` | `ctx` | 执行期上下文（取消信号必须响应——长耗时工具要监听 ctx.signal；callId 关联日志；log 记过程）。 |

## Tool（接口）

两阶段工具契约（§6.3）。name 强制 <module>__<tool>（规则 4）。

```ts
export interface Tool { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `name` | `name: string` |  |
| `description` | `description: string` |  |
| `parameters` | `parameters: ZodType` |  |
| `label?` | `label?: string` | 人类可读显示名（2026-09-24 用户拍板）：消息窗口工具行优先呈现（如 "Web Search"）—— 模型面永远用 name（调用/审批/配置不受影响）；缺省 = 宿主剥 <module>__ 前缀现算（旧行为）。 |
| `deferred?` | `deferred?: boolean` | 按需加载标记（M4-3 T4/D6）：真 = 该工具可被 ToolSearch 机制隐藏（schema 不进请求， 目录只知名+截断描述，经 tool-search__search 搜出并 reveal 后恢复）。tool-search 关态 = 标记 不生效（SW-26 联动规则——防「标了 deferred 却无 meta 工具可 reveal」永不可达组合）。 |
| `searchHint?` | `searchHint?: string` | 搜索补充关键词（目录呈现与打分的补充语料——cc-haha searchHint 同款）。 |
| `resolveExecution` | `resolveExecution(input: unknown): Promise<ToolExecution>` | 阶段一：声明（无副作用）——内核拿它跑并发调度与审批水缑；不许在此产生副作用。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `resolveExecution` | `input` | 模型给的参数（已过 parameters schema 校验；自行 as 收窄类型）。 |

## ToolInfo（接口）

ctx.tools.list 的出货形态（M4-3 T4）：目录数据源——只知名/描述/标记/reveal 态，不给 schema。

```ts
export interface ToolInfo { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `name` | `name: string` |  |
| `description` | `description: string` |  |
| `deferred` | `deferred: boolean` |  |
| `searchHint?` | `searchHint?: string \| undefined` |  |
| `label?` | `label?: string \| undefined` | 显示名透传（宿主渲染层消费——目录段不展示）。 |
| `revealed` | `revealed: boolean` | 已被 reveal（本轮起 schema 进请求——目录段应略过）。 |
| `owner` | `owner: string` | 注册属主模块名（MCP 桥接工具 = "mcp"——打分的 MCP 加权依据）。 |
## defineTool（函数）

```ts
export function defineTool(t: Tool): Tool;
```

**参数**

| 名 | 说明 |
|---|---|
| `t` | 工具定义（字段含义与范围见 Tool；name 强制 <module>__<tool> 前缀）。 |

**返回**：原定义对象（类型收窄 + 意图标注，不做运行期处理）。
