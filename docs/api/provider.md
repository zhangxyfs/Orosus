# provider 域 API 参考

> 提供商适配器契约——StreamFn 流式口、消息与工具规格形状、槽位解析辅助。
> 本文件由 `scripts/gen-api-docs.mts` 从 contracts 源生成（`pnpm gen-docs`，docs:check 门禁验同步）——
> 注释、@param（含义+范围）、@example 与源码同源；发现缺口门禁会红。

## Chunk（类型）

provider 中立流式词汇（§6.4）。错误带内编码：失败产出 finish{kind:"error"}，不许 reject。
errorCode 是适配器归一化的可编程错误码（M3 补强 D43，首枚 "context_limit" 上下文超限）——
只承载 loop/模块可编程消费的类别，不追求覆盖全部 API 错误（鉴权/限流等继续走 errorMessage 文本）。

```ts
export type Chunk =
```

## ContentPart（类型）

内容块（M4-2.5 T5 扩 image 引用形态）：text 直存；image 只存路径——日志不吃 base64 4/3 膨胀，
请求期由 provider 翻译层读文件转 base64（pi 两段式同款）；文件缺失诚实降级为文本占位。

```ts
export type ContentPart =
```

## MessageOrigin（类型）

用户消息出处标记（v3 compaction 设计空白 1，kimi 式元数据）：用户直敲的消息不带 origin；
steering 注入带 kind + 来源模块（sourceModule === "host" = 宿主 busy 期插队话）；压缩摘要消息带
compaction-summary。只在内部流转——provider 适配器拼线缆消息只取 role/content/toolCalls，不发给模型厂商。

```ts
export type MessageOrigin =
```

## ModelMessage（类型）

convertToLlm 投影产出的模型消息（日志投影 → 模型消息，§6.1 铁律）。

```ts
export type ModelMessage =
```

## ToolSpec（接口）

发给 provider 的工具描述（parameters 为 JSON Schema）。

```ts
export interface ToolSpec { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `name` | `name: string` |  |
| `description` | `description: string` |  |
| `parameters` | `parameters: Record<string, unknown>` |  |
## ProviderRequest（接口）

主循环/二级调用的统一请求体：适配器把它翻译成协议族线缆参数（openai chat / anthropic messages）。

```ts
export interface ProviderRequest { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `model` | `model: string` |  |
| `system` | `system: string` |  |
| `messages` | `messages: ModelMessage[]` |  |
| `tools` | `tools: ToolSpec[]` |  |
| `signal` | `signal: AbortSignal` |  |
| `maxTokens?` | `maxTokens?: number` | 输出 token 上限（M3 补强 D39 修订）：缺省 = 适配器现行为（openai 线缆不发送、anthropic 线缆用 MAX_TOKENS）。 |
| `webSearch?` | `webSearch?: boolean` | 声明服务端原生搜索（M4-3 T1b，SW-17）：适配器按协议映射为服务端搜索声明（openai 族 = tools 追加 {type:"web_search",web_search:{enable:true}}〔2026-09-24 zhipu 端点 spike 实钉的接受形态〕； anthropic 族 = web_search_20250305 server tool）。与 tools 的客户端工具正交——二级调用（D39）tools 恒空， 服务端声明不进会话、模型不可见。 |
| `reasoningEffort?` | `reasoningEffort?: string` | 思考投入档位（/effort 命令，2026-09-25）：值 = 模型目录（models.dev）reasoning_options 里 effort 型的档位字符串（low/high/max/none…），原样透传——适配器按协议族落线缆参数（openai 族 = reasoning_effort；anthropic 族 = thinking 开关与 budget_tokens 映射，kimi-code 同款口径）。 缺省不发送（端点默认行为）。值不做端点级校验（lenient——kimi-code 定案：不在清单也原样发，端点 400 自证）。 |
**示例**

```ts
stream({ model: "glm-4.7", system: "sys", messages, tools: [], signal });
```

## StreamFn（类型）

Provider SPI 唯一方法（§6.4）。

```ts
export type StreamFn = (request: ProviderRequest) => AsyncIterable<Chunk>
```

## classifyContextLimit（函数）

判定 HTTP 错误是否为上下文超限（溢出重试与压缩触发的判据，D43）。

```ts
export function classifyContextLimit(status: number, body: string): boolean;
```

**参数**

| 名 | 说明 |
|---|---|
| `status` | HTTP 状态码（只看 400/413，其余恒 false）。 |
| `body` | 错误响应体原文（大小写不敏感匹配关键词表）。 |

**返回**：true = 上下文超限（可重试/可压缩）。

## ProviderAdapter（类型）

Provider 适配器槽值（D32；模型发现修订）：裸函数或带默认模型/模型清单能力的对象——核心按形状归一化。

```ts
export type ProviderAdapter =
```

## parseModelsResponse（函数）

解析 openai 形 /models 响应为模型 id 清单（模型目录能力的消费端）。

```ts
export function parseModelsResponse(body: unknown): string[];
```

**参数**

| 名 | 说明 |
|---|---|
| `body` | 响应 JSON（形如 { data: [{ id: "glm-4.7" }, ...] }；形状不符或无合法 id 抛错）。 |

**返回**：模型 id 去重清单（版本号大的排前，合法 id 仅限字母数字与 . _ / - ）。

## providerSlotKey（函数）

提供商能力槽的标准 key（"provider:<名>"）。

```ts
export function providerSlotKey(name: string): string;
```

**参数**

| 名 | 说明 |
|---|---|
| `name` | 提供商名（与 provide/获取两侧同名对齐；大小写敏感）。 |

**返回**："`provider:<name>`" 形字符串。
