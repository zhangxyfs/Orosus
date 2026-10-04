# Hooks 生命周期钩子——协议参考

钩子是你在配置文件里声明的 shell 命令，Orosus 在七个关键时机自动执行它们：拦截危险命令、自动放行安全的、往上下文里注入项目知识、完成时发个通知。**协议即 API，无代码 SDK**——钩子都是裸脚本：stdin 读一行 JSON、按退出码表态、stdout 可回 JSON 决策。协议与 Claude Code 生态兼容，现成的 Claude hooks 脚本零改动可跑。

> 快速上手：`~/.orosus/modules.d/hooks.toml` 抄一份出厂注释模板（三场景示例）改改即可；`/settings → 钩子` 看清单、启停、审查项目层。改完 `/reload` 生效。

## 事件与配置

```toml
[hooks]
enabled = true          # 总闸
timeoutMs = 60000       # 全局默认超时（毫秒）

[[hooks.PreToolUse]]            # 事件名作表数组；省略 matcher = 全匹配
matcher = "^tool-shell__bash$"  # 正则：大小写敏感、不隐式锚定（全名匹配自带 ^$）
[[hooks.PreToolUse.hooks]]
command = "python3 guard.py"    # ${OROSUS_PROJECT_DIR} / ${CLAUDE_PROJECT_DIR} 模板可用
timeout = 30                    # 秒；缺省或 0 = 用全局 timeoutMs（哨兵语义，非零超时）
disabled = false                # /settings 钩子面 e 键写盘位
```

两层配置：用户级 `~/.orosus/modules.d/hooks.toml` 与项目级 `<项目>/.orosus/modules.d/hooks.toml`——两层**追加合并**（同事件不去重，执行序用户层在前），标量（enabled/timeoutMs）项目层覆盖用户层。**项目层首次生效前须经信任审查**（见下）。每层每事件可配多张表、每表多条命令，同事件串行执行、首个 deny 后短路。

## 七事件

| 事件 | 触发时机 | 事件专有载荷字段 | 能做什么 |
|---|---|---|---|
| SessionStart | 会话创建 / 恢复 / fork | `source`（startup/resume/fork） | 注入上下文；不可阻断 |
| UserPromptSubmit | 用户消息落日志**之前** | `prompt` | 整条拒收（消息不进上下文）；注入上下文 |
| PreToolUse | 工具执行前、**审批之前** | `tool_name` `tool_input` `tool_use_id` | 拦截（deny）；改参（`updatedInput`）；allow 在此**无升档效力** |
| PermissionRequest | 审批弹窗询问**之前** | `tool_name` `tool_input` | 代答 allow（跳过弹窗放行）/ deny（直接拒绝）；不表态照常弹窗 |
| PostToolUse | 工具执行成功后 | `tool_name` `tool_response` `tool_use_id` | 观测；注入上下文 |
| PostToolUseFailure | 工具执行失败后 | `tool_name` `tool_response`（含错误）`tool_use_id` | 观测；注入上下文 |
| Stop | 停止边界、turn 收口前 | `stop_hook_active` | 阻止停止=续跑（连续续跑封顶 3 次防死循环；用户发新消息清零） |

matcher 作用于**事件匹配值**：工具事件=工具名、SessionStart=source；UserPromptSubmit/Stop 无匹配值，matcher 恒忽略（写了不报错）。matcher 非法正则 = 该 matcher 永不匹配 + 启动警告（不炸配置加载）。子代理的工具调用同样触发工具三事件（stdin 载荷多 `agent_id`/`agent_type` 两字段）。

## stdin 载荷

一行 snake_case JSON（公共五字段 + 事件专有字段）：

```json
{"hook_event_name":"PreToolUse","session_id":"s_xxx","transcript_path":"…session.jsonl","cwd":"/proj","permission_mode":"ask-risky","tool_name":"tool-shell__bash","tool_input":{…},"tool_use_id":"c1"}
```

`permission_mode` 三值：ask-always / ask-risky / never。

## 退出码

| 退出码 | 语义 |
|---|---|
| 0 | 放行（stdout 以 `{` 开头才按 JSON 解析决策） |
| 2 | 阻断——理由取 stderr 优先、空则 stdout；stdout 同时给了合法 JSON 决策时以 JSON 为准（JSON 是完整决策面，exit 2 只是「阻断+读 stderr」的简写） |
| 其他非零 | 非阻塞错误（fail-open——不阻断主流程，`hooks/run` 落账） |

超时（全局 60s / per-hook 秒数）会被杀进程树（Windows `taskkill /T /F`），同样按非阻塞错误处理。

## stdout JSON 决策

`{` 开头才解析；**顶层字段与 `hookSpecificOutput` 内字段同级展开**（两种形态都认；`additional_context` 蛇形也认）。只认已知字段、其余忽略：

| 字段 | 取值 | 用在 |
|---|---|---|
| `permissionDecision` | `"allow"` / `"deny"` / `"ask"` | PreToolUse（ask=无动作、allow 无升档）；PermissionRequest（allow=跳弹窗放行、deny=拒绝） |
| `decision` | `"block"` / `"approve"` | Stop（block=阻止停止） |
| `reason` / `stopReason` | 字符串 | deny / block 的理由 |
| `updatedInput` | 对象 | PreToolUse 改参——替换 `tool_input`，重过参数校验与审批（审批只见最终参数；修订账落会话日志） |
| `additionalContext` | 字符串 | 注入上下文（SessionStart/UserPromptSubmit/PostToolUse/Failure） |

示例：`{"hookSpecificOutput":{"permissionDecision":"deny","reason":"rm -rf 不许跑"}}` 或顶层同款。

## 环境变量与模板

- 子进程**继承宿主环境**，剔除变量名含 `TOKEN`/`KEY`/`SECRET`/`PASSWORD`（大小写不敏感包含匹配）的敏感变量。
- 注入 `OROSUS_PROJECT_DIR` 与 `CLAUDE_PROJECT_DIR`（同值=项目绝对路径，双发兼容生态脚本）。
- 命令串里 `${OROSUS_PROJECT_DIR}` / `${CLAUDE_PROJECT_DIR}` 模板展开。

## 注入三道闸

- 单条上限 **16,000 字符**（additionalContext 与 Stop 续跑理由同帽），超出截断并加可读标记 `[截断：原文 N 字符，保留前 16000]`；
- 会话累计上限 **64,000 字符**，超限后本会话不再注入（toast 提示一次）；
- 净化：剥 ANSI/VT 转义序列与 C0/C1 控制字符（保留换行）；注入正文带固定包裹头 `[非用户输入] 钩子注入（<事件>）`——**prompt 永不改写**，注入一律走旁路消息，你可以在流区看到折叠行（灰字「上下文注入 · 事件 · N 字符」），**Ctrl + H** 打开注入查看窗看全文。

## 信任门（项目层）

项目 `.orosus/modules.d/hooks.toml` 是仓库内容（可能来自别人），不审查就执行等于把「任意命令执行」写进 repo。规则：项目层配置节 canonical JSON 的 **sha256** 为 digest；`~/.orosus/hooks/hooks-trust.json` 登记过且匹配才执行——不匹配/未登记=整层不执行（用户层不受影响），每次派发前现算（改了配置立即重新待审）。审查动作：`/settings → 钩子 → 项目级行 → 详情 → t`（展示命令清单与 digest，确认即登记、即时生效）。

## 可见性

- 拦截永远明示：工具被拦走既有 Error 工具行（`钩子拦截（<钩子名>）：<理由>`）；提交被拒 toast 显示钩子名、理由与被拒原文首行。
- 钩子运行 ≥300ms 状态区亮灰字「正在运行钩子 <名>…（N/M）」。
- 审计：每次触发/阻断/超时/失败/待审跳过都落一条 `hooks/run` 会话事件（查看浏览器是顺延项，当前以状态行+折叠行+修订注记三层留痕）。

## 模块开发者

进程内不需要 shell——既有 `ctx.events.on` + `mounts: ["hook:<type>"]` 即 API：本批新增三个可订阅点 `tool/pre-input`、`user/prompt-submit`、`session/start`（waterfall 两枚可阻断 + emit 一枚），配合既有 `tool/post-execute`/`agent/follow-up`/`agent/steering`。不另定义第二套 API。

## 两个完整示例

**PreToolUse 拦截（bash）**——stdin 读 JSON，危险命令 exit 2：

```bash
#!/usr/bin/env bash
# guard.sh —— 拦截 rm -rf
input=$(cat)
if echo "$input" | grep -q '"command"[^:]*:[^"]*"rm -rf'; then
  echo "rm -rf 被项目守卫拦下——请改用回收站或明确 narrower 路径" >&2
  exit 2
fi
exit 0
```

```toml
[[hooks.PreToolUse]]
matcher = "tool-shell__bash"
[[hooks.PreToolUse.hooks]]
command = "bash \"${OROSUS_PROJECT_DIR}/scripts/guard.sh\""
```

**SessionStart 注入（python）**——stdout 回 JSON：

```python
#!/usr/bin/env python3
import json, sys
payload = json.loads(sys.stdin.readline())
# 只在全新会话注入（resume/fork 不重复）
if payload.get("source") == "startup":
    print(json.dumps({"additionalContext": "项目知识：构建用 pnpm、测试跑 npx vitest run、目录结构见 README。"}, ensure_ascii=False))
```

```toml
[[hooks.SessionStart]]
matcher = "startup"
[[hooks.SessionStart.hooks]]
command = "python3 \"${OROSUS_PROJECT_DIR}/scripts/onstart.py\""
```
