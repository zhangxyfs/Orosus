# Orosus 模块开发者指南

> `@orosus/contracts` 是模块开发者的唯一编程面——本文是人类版指南；`catalogJson()` 是运行时机器可读版。
> 入门教程（从零做一个模块）见 [module-walkthrough.md](module-walkthrough.md)；本文是速查与纪律。

## 仓库目录地图（§4/§9，v26）

```
Orosus/
├─ apps/cli/                          # 唯一前端：REPL + 子命令（provider/module）
├─ packages/
│  ├─ core/src/                       # 核心五件 + kernel（§4）
│  │  ├─ session/  loop/  tool/  provider/  kernel/  config/
│  │  ├─ diag/                        # §11.9 专用诊断日志（独立旁路管线）
│  │  └─ harness.ts                   # §8.1 createHarness 编程式入口（嵌入式宿主/测试用）
│  ├─ contracts/src/                  # 零依赖契约，按域分包：module / tool / provider / fs（§9）
│  ├─ testing/                        # 测试基建：fakeProvider / fakeProviderModule / fakeModule
│  └─ modules/                        # 内置模块（规则 5：与外部模块走同一条 kernel 注册管线——目录归置≠特权）
│     ├─ tool-fs/  tool-shell/        #   能力模块（fs seam 的提供者/消费者）
│     ├─ skill/  mcp/                 #   内容系统 / MCP 桥接
│     └─ provider-{anthropic,glm,kimi,deepseek,openai}/  provider-custom/
│                                     #   品牌适配器（D31/D34 封顶五家）+ 自定义厂商统一入口（D33/D34）
└─ tests/                             # 跨包集成测试（模块图/信任门/reload/多 provider 共存等端到端）
```

读法：**核心件**（core，禁止 import 任何模块）→ **契约**（contracts，模块唯一可 import 的 Orosus 包）→ **测试基建**（testing，非模块）→ **内置模块**（modules/，包名 `@orosus/<name>` 不含目录层级）→ **前端**（apps）。新增顶层目录/分组先修设计文档 §4/§9（§11.11 验收纪律：无设计外居民）。

## 最小完整模块（可复制）

```ts
import { defineModule } from "@orosus/contracts/module";
import { defineTool } from "@orosus/contracts/tool";
import { z } from "zod";

export default defineModule({
  name: "my-module",                    // kebab-case，全局唯一（规则 4）
  version: "0.1.0",
  description: "一句话说明",
  api: 1,                               // 核心兼容窗口：支持 N 与 N-1（§8.5）
  provides: ["my-module.x"],            // 能力声明（规则 1：公共短名只能在 contracts 登记，否则带模块名前缀）
  uses: ["fs.read"],                    // 高权限自声明（L0 展示/L1 强制/L2 RPC 面）
  activate(ctx) {
    ctx.provide("my-module.x", { hello: () => "world" });
    ctx.contribute.tool(defineTool({
      name: "my-module__hello",         // <module>__<tool> 强制前缀（规则 4）
      description: "问好",
      parameters: z.object({}),
      resolveExecution: async () => ({
        accesses: [{ kind: "fs.read", path: "." }],   // fail-closed 缺省 = kind:"all"（§6.3）
        approvalRule: "my-module__hello",
        execute: async () => ({ output: "world", isError: false }),
      }),
    }));
    return { dispose() { /* 注册之外的清理（句柄/子进程）——规则 3 */ } };
  },
});
```

## 何时被谁调用（§11.10 五要素之"调用时机"）

- `activate`：启动/reload 的拓扑序中调用一次；此间 `ctx.services.get` 保证硬依赖已入册（§5.2 规则 2）。
- `dispose`：模块被停用（close/reload 换代/回滚）时调用——先于各注册的 disposer（§5.2 规则 3）。
- 工具两阶段：`resolveExecution`（声明，无副作用）→ waterfall → `execute`（唯一副作用点）；错误一律带内 `isError`，不许 reject（§6.3）。
- `configRead()`：运行期读自身配置（overlay 复合后）；activate 期只保证纯分层值（§6.6）。

## 能力契约目录

| 能力 key | 契约 | 提供者示例 |
|---|---|---|
| `fs` | `@orosus/contracts/fs` 的 `Fs`（read/write） | tool-fs |
| `provider:<name>` | `@orosus/contracts/provider` 的 `ProviderAdapter`（保留槽，经 `provide` 注册） | provider-custom（唯一 provider——品牌 ×5 已退役 2026-09-23，/provider 向导即完整配置入口） |

## 贡献点与拦截点

- 贡献点：`tool` / `command`（`/<module>__<cmd>`）/ `promptSection`（order ≤ -100 为核心保留区）/ `configOverlay`（读侧，D2）
- 拦截点（§6.5 白名单 8 个）：`agent/pre-step`（emit）、`agent/transform-context`（reduce）、`agent/steering`、`agent/follow-up`（collect）、`agent/should-stop`（布尔 OR）、`tool/pre-execute`（waterfall，审批在此）、`tool/post-execute`（emit）、`ui/command`（emit）
- 运行时清单：`harness.graph().catalogJson()`（或 CLI `--dump-modules`）

## 错误行为

- StreamFn 不许 reject——错误编码为 `finish{kind:"error"}`（§6.4）
- 工具执行不许 reject——带内 `{ output, isError: true }`（§6.3）
- 激活抛错 → 模块降级不阻断（§10）；`required = true` 的模块失败才阻断启动

## 验收纪律：单测全绿 ≠ 能用（2026-09-18 走查定案）

单测测不出真实用户体验侧的缺陷——2026-09-18 走查实录：测试全绿的代码在真实运行里连出
ENOENT 崩溃、`$ENV` 占位符原文上屏（401）、目录静默降级成 7 家快照、同前缀厂商错配
（选 `zhipuai-coding-plan` 导入了普通 `zhipuai`）、密钥输入回显在 Windows 终端层碎成孤星。
五类缺陷没有一个被单测拦住。**凡改 CLI/向导/渲染/配置链路，收尾前必须以普通用户视角真实运行一遍**：

```bash
# 配方（HERMETIC：USERPROFILE 隔离配置/密钥/会话/缓存，mock 端点不烧真钱）：
# 1. mock 端点（GET /models + POST chat/completions SSE，GLM 方言：reasoning_content + usage 同帧）
# 2. 本地 api.json 指向 mock，向导走「本地文件」源 → 落盘缓存 → /reload → hello → /usage → /quit
printf '%s\n' "/provider" "1" "2" "<api.json 的 Windows 路径>" "" "1" "<mock-key>" "1" "/reload" "hello" "/usage" "/quit" \
  | USERPROFILE='C:\tmp\orosus-e2e\home' node --experimental-strip-types apps/cli/src/main.ts
```

验收点（看真实 stdout，不看测试报告）：向导每级菜单文案、`success` 横幅含端点/密钥/模型/窗口、
`[思考]` 块与正文渲染、`/usage` 双口径有真实数字、`/quit` 退出码 0、过程中无栈迹无明文密钥。
