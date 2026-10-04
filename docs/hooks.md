# Hooks 生命周期钩子——完整参考

钩子是你在配置文件里声明的 shell 命令，Orosus 在七个关键时机自动执行它们：拦截危险命令、自动放行安全的、往上下文里注入项目知识、完成时发个通知。**协议即 API，无代码 SDK**——钩子都是裸脚本：stdin 读一行 JSON、按退出码表态、stdout 可回一行 JSON 决策。协议与 Claude Code 生态兼容，现成的 Claude hooks 脚本零改动可跑。

> 快速上手：`~/.orosus/modules.d/hooks.toml` 抄一份出厂注释模板改改即可（首次创建 modules.d 时自动播种）；`/settings → 钩子` 看清单、启停、审查项目层；改完 `/reload` 生效。完整协议参考就是本文。

---

## 1. 配置文件

### 1.1 文件位置与分层

| 层 | 文件 | 生效条件 |
|---|---|---|
| 用户级 | `~/.orosus/modules.d/hooks.toml` | 直接生效 |
| 项目级 | `<项目根>/.orosus/modules.d/hooks.toml` | **首次生效前须经信任审查**（见 §8）；改内容后需重审 |

合并规则：

- **事件表追加合并**：两层同事件都配置时不去重，全部执行；**执行序 = 用户层在前、项目层在后**，层内按表出现顺序、表内按条目顺序。
- **标量键覆盖合并**：`enabled` / `timeoutMs` 项目层出现即覆盖用户层。
- 项目层未过信任门 = **整层跳过**（用户层不受影响）。
- 两层都没有事件表 = 零监听、零执行。

### 1.2 `[hooks]` 节键（全局）

| 键 | 类型 | 默认 | 可填值与规则 |
|---|---|---|---|
| `enabled` | 布尔 | `true` | 总闸。`false` = 不注册任何监听（配置照读、零执行） |
| `timeoutMs` | 整数（毫秒） | `60000` | 全局默认超时。**最小 1000**——低于 1000 配置校验失败、模块激活失败（启动弹降级窗） |
| `userConfigFile` | 字符串 | `~/.orosus/modules.d/hooks.toml` | 高级键：用户层文件路径覆盖（测试/特殊部署用，日常不写） |
| `projectConfigFile` | 字符串 | `<cwd>/.orosus/modules.d/hooks.toml` | 高级键：项目层文件路径覆盖（同上） |
| `trustFile` | 字符串 | `~/.orosus/hooks/hooks-trust.json` | 高级键：信任记录文件路径覆盖（同上） |

> **形态铁则**：所有键必须包在 `[hooks]` 节头下（事件表写作 `[[hooks.PreToolUse]]`）。写在文件顶层的键不归本模块（会被装载层当核心配置收走），既不生效也可能污染全局配置。

### 1.3 事件表 `[[hooks.<事件名>]]`

`<事件名>` 七选一（区分大小写）：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `Stop` / `PermissionRequest`。**未收录的事件名整表被忽略**（`Notification`、`SessionEnd`、`PreCompact` 等暂未收录——写了不报错也不生效）。未知键一律剥除（静默忽略）。

| 键 | 类型 | 必填 | 可填值与规则 |
|---|---|---|---|
| `matcher` | 字符串（正则） | 否 | 省略 = 全匹配。写了 = 按正则原样编译（`new RegExp`）：**大小写敏感**（无 i 标志）、**不隐式锚定**（子串即命中；全名匹配须自带 `^...$`）。作用于**事件匹配值**——工具事件 = 工具全名（如 `tool-shell__bash`、`tool-fs__write`）、SessionStart = `source` 三值（见 §2）、UserPromptSubmit / Stop **无匹配值，matcher 恒忽略**（写了不报错）。非法正则 = 该 matcher 永不匹配 + 启动警告（不炸配置加载） |
| `hooks` | 钩子条目数组 | 是 | **至少 1 条**。表内条目串行执行（见 §1.5） |

matcher 示例：`"^tool-shell__bash$"`（只匹配 bash 工具全名）；`"tool-fs__"`（所有文件工具——无锚定子串命中）；`"startup|resume"`（SessionStart 的两种来源，无锚定子串命中）。

### 1.4 钩子条目 `[[hooks.<事件名>.hooks]]`

| 键 | 类型 | 必填 | 可填值与规则 |
|---|---|---|---|
| `command` | 字符串 | 是 | **任意 shell 命令串**（非空）。经 `bash -c` 执行（Windows 走 Git Bash，Unix 走 sh）——**语言不限**：bash / python / node / perl / powershell 脚本、`npx`/`grep` 拼管道、单行内联判断都行（协议只认 stdin / 退出码 / stdout，见 §4–§6）。仅 `${OROSUS_PROJECT_DIR}` 与 `${CLAUDE_PROJECT_DIR}` 两个模板由 Orosus 预展开；其余 `$VAR` 由 shell 自行展开（环境已继承，见 §7） |
| `name` | 字符串 | 否 | **1–60 字符**。说明/显示名——/settings 钩子列表行、运行中状态行（`正在运行钩子 <name>…`）、阻断提示（`钩子（<name>）拦截`）、注入折叠行（`<name> 注入 · N 字符`）优先用它；缺省回退：列表=事件名、提示=命令短名（见 §8 短名规则）。**纯显示元数据**：不进 stdin 载荷、不参与 matcher |
| `product` | 字符串 | 否 | **1–40 字符**。归属产品（如 `OpenKnowledge`）——列表行徽标与归类、`hooks/run` 审计带 `product` 字段；多产品共装时按此辨识。**纯显示元数据**，同上 |
| `timeout` | 整数（秒） | 否 | **≥ 0**。缺省或 `= 0` = 用全局 `timeoutMs`（**0 是「用默认」的哨兵，不是零超时**）。到点杀整进程树（win32 `taskkill /T /F`、Unix 进程组 SIGKILL），按非阻塞失败处理（fail-open，见 §5） |
| `disabled` | 布尔 | 否 | 缺省 `false`。`true` = 该条跳过不执行（配置保留，重新启用即恢复）——`/settings → 钩子 → e` 键写的就是这个键 |

### 1.5 脚本放在哪里

Orosus 不规定脚本位置与语言——`command` 是任意 shell 命令串，本文件只负责登记与指路：

| 场景 | 脚本位置 | 登记方式 |
|---|---|---|
| 随项目分发（协作者共享） | 项目仓库任意目录（惯例 `<项目>/scripts/`），随版本控制提交 | 项目层用 `${OROSUS_PROJECT_DIR}/scripts/<名>` 引用；协作者拉取后**首次生效前须信任审查**（§8——仓库里的钩子就是「别人写的任意命令执行」，这正是门的理由） |
| 个人自用 | 任意磁盘位置（建议收纳在 `~/.orosus/hooks/` 个人脚本目录） | 用户层登记，绝对路径或模板变量均可 |
| 单行逻辑 | 不需要文件 | `command` 直接内联（`node -e "…"`、`grep … && exit 2` 拼管道——见 §12 示例三） |
| Claude 生态现成钩子 | 把脚本拷到本项目/本机 | 照原样登记；命令里的 `${CLAUDE_PLUGIN_ROOT}` 等外部模板换成本机绝对路径 |

没有插件分发渠道（暂未做）——现阶段共享钩子 = 脚本进仓库或手工搬运。

### 1.6 执行规则

- 同事件多条命令**串行**执行，执行序 = 两层合并序（§1.1）。
- **deny 粘滞短路**：任一条返回阻断（exit 2 / JSON deny / JSON block），**后续条目不再执行**。
- fail-open 铁律：崩溃、超时、输出不合法、进程起不来——一律不阻断主流程，落一条审计账继续。
- stdout / stderr 各截 **64KB**（采集帽，先于 JSON 解析）。
- 每次触发/阻断/超时/失败/跳过都落一条 `hooks/run` 会话事件（字段见 §9）。

---

## 2. 七事件

| 事件 | 触发时机 | 匹配值（matcher 作用对象） | 能做什么 |
|---|---|---|---|
| `SessionStart` | 会话创建 / 恢复 / fork | `source`：`startup` \| `resume` \| `fork` | 注入上下文；**不可阻断** |
| `UserPromptSubmit` | 用户消息落日志**之前** | 无（matcher 恒忽略） | 整条拒收（消息不进上下文）；注入上下文 |
| `PreToolUse` | 工具执行前、**审批之前** | 工具全名（`<模块>__<名>`，如 `tool-shell__bash`） | 拦截（deny）；改参（`updatedInput`）；`allow` 在此**无升档效力** |
| `PermissionRequest` | 审批弹窗询问**之前**（ask 档才到得了这里；never 档无弹窗不触发） | 工具全名 | 代答 allow（跳过弹窗放行）/ deny（直接拒绝）；不表态照常弹窗 |
| `PostToolUse` | 工具执行成功后 | 工具全名 | 观测；注入上下文 |
| `PostToolUseFailure` | 工具执行失败后（含被拦/超时等一切 isError 结果） | 工具全名 | 观测；注入上下文 |
| `Stop` | 停止边界、turn 收口前（**错误/中止轮不触发**） | 无（matcher 恒忽略） | 阻止停止 = 代理带理由续跑；连拦封顶 3 次，用户发新消息计数清零 |

子代理的工具调用**同样触发**工具三事件（PreToolUse / PostToolUse / PostToolUseFailure），stdin 载荷多两个身份字段（见 §3）；Stop / SessionStart / UserPromptSubmit 不被子代理触发。

---

## 3. stdin 载荷（一行 snake_case JSON）

### 3.1 公共字段（所有事件）

| 字段 | 类型 | 说明 |
|---|---|---|
| `hook_event_name` | 字符串 | 七事件名之一 |
| `session_id` | 字符串 | 会话 id（冷启动竞态下可能缺席） |
| `transcript_path` | 字符串 | 会话主文件绝对路径（极早期事件可能缺席） |
| `cwd` | 字符串 | 项目绝对路径 |
| `permission_mode` | 字符串 | `ask-always` \| `ask-risky` \| `never`（SessionStart 缺省此字段） |

### 3.2 事件专有字段

| 事件 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `UserPromptSubmit` | `prompt` | 字符串 | 完整提交文本 |
| | `images` | 字符串[] | **仅带图提交时在场** |
| `PreToolUse` | `tool_name` | 字符串 | 工具全名 |
| | `tool_input` | 对象 | 工具参数 |
| | `tool_use_id` | 字符串 | 调用 id |
| `PostToolUse` / `PostToolUseFailure` | `tool_name` / `tool_use_id` | 字符串 | 同上 |
| | `tool_input` | 对象 | **工具实收参数（改参后为最终值）**——事后归因类钩子（触碰记账等）从这取 `path` 等入参。cc 口径同款（PostToolUse 同时带 tool_input 与 tool_response） |
| | `tool_response` | 对象 | `{ "output": 字符串, "is_error": 布尔, "denied"?: true（被拦）, "truncated"?: true（超长截断） }` |
| `PostToolUseFailure` 专有 | `error` | 字符串 | 失败摘要（= tool_response.output）——cc 形态，生态脚本读 `input.error` |
| `Stop` | `stop_hook_active` | 布尔 | 本链已续跑过则为 `true`（首次停止为 `false`）——防死循环自检用 |
| | `last_assistant_message` | 字符串 | 末条 assistant 回复全文——停止钩子据此判定要不要拦停（cc 同款；行模式宿主无消息读口时缺席） |
| `PermissionRequest` | `tool_name` / `tool_input` | — | 与 PreToolUse 同形。`permission_suggestions`：cc/ZCode 类型面有此键但**从不赋值**（stdin 恒缺席）——三家实际一致，无需此键 |
| `SessionStart` | `source` | 字符串 | `startup` \| `resume` \| `fork`。与 cc 的差异：不带 `model` / `agent_type`（无会话级模型事件源），source 取值集也不同（cc 另有 `clear` / `compact`——Orosus 无对应触发位） |

**从 kimi 系脚本搬运的注记**（三源实查：cc/ZCode/kimi 字段名有分歧）：kimi 的工具调用 id 叫 `tool_call_id`（cc/ZCode/本仓 = `tool_use_id`）、结果字段叫 `tool_output`（裸字符串、截 2000；cc/ZCode/本仓 = `tool_response`，本仓为结构化对象 `{output, is_error, ...}`）；kimi 的 Stop 载荷无 `last_assistant_message`。搬 kimi 脚本时改这三个字段名即可。

### 3.3 子代理附加字段（工具三事件）

| 字段 | 类型 | 说明 |
|---|---|---|
| `agent_id` | 字符串 | 子代理 8 位 hex 编号 |
| `agent_type` | 字符串 | 派单时的 label（工种名） |

---

## 4. 退出码

| 退出码 | 语义 |
|---|---|
| `0` | 放行。stdout **以 `{` 开头**才按 JSON 解析决策（§5） |
| `2` | 阻断。理由取值优先级：stdout JSON 的 `reason`/`stopReason` > **stderr 非空** > stdout 非空（且无 JSON 决策）> 默认文案「钩子阻断（exit 2，未给理由）」。**stdout 给了合法 JSON 决策时以 JSON 为准**（exit 2 只是「阻断+读 stderr」的简写，JSON 是完整决策面——JSON 明示 `allow` 时放行） |
| 其他非零 | 非阻塞错误（fail-open：不阻断主流程，落审计账继续下一条） |
| 超时 / 起不来 | 同上按非阻塞处理（杀树 / spawn 失败） |

---

## 5. stdout JSON 决策

stdout 以 `{` 开头才解析；解析失败（形似非 JSON）= 当无决策（非阻塞）；只认下列已知字段、其余忽略。

**兼容壳**：顶层字段与 `hookSpecificOutput` 内字段**同级展开**（两种形态都认，同名冲突顶层赢）；`additional_context` 蛇形也认（superpowers polyglot 第三形态）。

| 字段 | 类型 | 取值 | 适用事件 | 行为 |
|---|---|---|---|---|
| `permissionDecision` | 字符串 | `"deny"` | PreToolUse | 拦截工具（理由用 `reason`） |
| | | `"deny"` | UserPromptSubmit | 拒收消息 |
| | | `"deny"` | Stop | 阻止停止（= 续跑） |
| | | `"deny"` | PermissionRequest | 代答拒绝 |
| | | `"allow"` | PermissionRequest | **代答放行（跳过弹窗）——allow 升档效力只在这里成立** |
| | | `"allow"` | PreToolUse | 无动作（无升档——放行只走 PermissionRequest） |
| | | `"ask"` / 缺省 | 全部 | 无动作（PreToolUse 放行；PermissionRequest 照常弹窗） |
| `decision` | 字符串 | `"block"` | Stop（Claude 同名形态） | 阻止停止 = 续跑（理由用 `stopReason` > `reason`）；其他事件同折阻断 |
| | | `"approve"` 或其他 | Stop | 不阻止（正常停止） |
| `reason` | 字符串 | 任意 | 全部 | deny / block 的理由（阻断明示给用户看） |
| `stopReason` | 字符串 | 任意 | Stop | 续跑理由（优先于 `reason`） |
| `updatedInput` | 对象 | 替换后的**完整** `tool_input` | **仅 PreToolUse**（其他事件忽略） | 改参：替换工具参数 → 重过参数校验与审批（审批/写闸只见最终参数）→ 修订账落会话日志。重校验失败按 fail-open 回原参数 |
| `additionalContext` | 字符串 | 注入正文 | SessionStart / UserPromptSubmit / PostToolUse / PostToolUseFailure | 注入上下文（过三道闸，见 §7.3）。**PreToolUse 不支持注入**（时机不对位，顺延）；Stop 的续跑理由走 `reason`/`stopReason` 通道 |

---

## 6. 环境变量与模板变量

| 项 | 规则 |
|---|---|
| 环境继承 | 子进程**继承宿主全部环境**；剔除变量名含 `TOKEN` / `KEY` / `SECRET` / `PASSWORD` 的变量（大小写不敏感、**包含**匹配——`MY_TOKEN`、`API_KEY` 都剔；过宽误伤面已知，后续按实损收紧） |
| 注入变量 | `OROSUS_PROJECT_DIR` 与 `CLAUDE_PROJECT_DIR`（同值 = 项目绝对路径；双发兼容 Claude 生态脚本） |
| 命令串模板 | `${OROSUS_PROJECT_DIR}`、`${CLAUDE_PROJECT_DIR}` 由 Orosus **预展开**；其余 `${VAR}` 不预展开（由 shell 按继承环境自行展开） |

---

## 7. 数值与格式

### 7.1 超时

全局默认 **60 秒**（`timeoutMs`，最小 1000）；per-hook `timeout` 秒数再覆盖（`0`/缺省 = 用全局）。到点杀整树。

### 7.2 采集帽

stdout / stderr 各 **64KB**（先于 JSON 解析、与注入帽解耦——大 `additionalContext` 的 JSON 不会被截断破坏）。

### 7.3 注入三道闸

| 闸 | 数值 | 行为 |
|---|---|---|
| 单条帽 | **16,000 字符**（`additionalContext` 与 Stop 续跑理由同帽） | 超出截断 + 可读标记 `[截断：原文 N 字符，保留前 16000]` |
| 会话累计帽 | **64,000 字符** | 超限后本会话不再注入 + toast 提示一次 + 审计落 `skipped-inject-cap` |
| 净化 | — | 剥 ANSI/VT 转义序列（CSI/OSC）与 C0/C1 控制字符（保留 `\t` `\n` `\r`） |

注入正文带固定包裹头（正文里伪造同款头无法越过包裹层）：

```
[非用户输入] 钩子注入（<事件名>）           ← 未配 name
[非用户输入] 钩子注入（<事件名> · <name>）   ← 配了 name（折叠行据此显示「<name> 注入」）
────────
<正文>
```

同事件多条注入合并 = `#1 …` `#2 …` 编号 + 空行连接。**prompt 永不改写**——注入一律走旁路消息，流区有折叠行（灰字「<name> 注入 · N 字符」；未配 name 时「上下文注入 · <事件名> · N 字符」），**Ctrl + H** 打开注入查看窗看全文。

---

## 8. 信任门（项目层）

项目 `.orosus/modules.d/hooks.toml` 是仓库内容（可能来自别人），不审查就执行等于把「任意命令执行」写进 repo。

| 项 | 规则 |
|---|---|
| 信任文件 | `~/.orosus/hooks/hooks-trust.json`，JSON：`{ "<项目桶名>": { "digest": "<64 位 hex>", "trustedAt": "<ISO8601>" } }` |
| 桶名 | 项目路径归一（win32 盘符小写）后 `encodeCwd`（非法字符清洗截 50 + sha1 前 8 位）——同项目跨会话同键 |
| digest | 项目文件 `[hooks]` 节**解析内容**的 canonical JSON（对象键递归排序，与文件里键序无关）的 **sha256** |
| 评估时机 | **每次派发前现算**（不缓存）——改了配置立即重新待审，无须重启 |
| 判定 | 无项目文件 = 不适用；digest 匹配 = 放行；不匹配 / 未登记 / 信任文件损坏 = 项目层**整层跳过**（审计落 `skipped-untrusted` + 每会话一次 toast；用户层不受影响） |
| 审查口 | `/settings → 钩子 → 项目级行 → 详情 → t`（展示命令清单与 digest，确认即登记、即时生效） |

---

## 9. `hooks/run` 审计事件（会话日志，可回放）

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` | 整数 | 运行序号——`running` 账与完成账配对（状态行数据源） |
| `event` | 字符串 | 七事件名 |
| `hook` | 字符串 | 命令原文 |
| `name` | 字符串 | 钩子显示名（配了 `name` 才在场） |
| `product` | 字符串 | 归属产品（配了 `product` 才在场） |
| `matcher` | 字符串 | 该表 matcher（写了才在场） |
| `subagent` | 字符串 | 子代理 agent_id（子代理触发才在场） |
| `status` | 字符串 | `running`（运行 ≥300ms 显形账，带 `index`/`total` N/M 计数）\| `pass` \| `deny` \| `error`（非零/起不来）\| `timeout` \| `stop-cap`（连拦 3 次封顶放行）\| `skipped-untrusted`（项目层待审跳过）\| `skipped-inject-cap`（累计帽跳过注入） |
| `reason` / `detail` | 字符串 | deny 理由 / 错误明细 |
| `durationMs` | 整数 | 耗时 |

另有 `hooks/input-rewrite` 修订账：`{ callId, from, to }`——模型在对话流看到的仍是原始参数，审批与执行见改后参数，两侧靠它对账。

---

## 10. 界面可见性

- **阻断永远明示**：工具被拦走既有 Error 工具行（`钩子拦截（<显示名>）：<理由>`）；提交被拒 toast `钩子（<显示名>）拦截：<理由>｜被拒原文「首行≤40 字」`。显示名解析序 = **`name` 字段优先**；未配 name 时用命令短名（首词 basename，解释器（python3/node/bash/npx…）带第二词）。
- **运行中**：钩子运行 ≥300ms 状态区亮灰字 `正在运行钩子 <显示名>…（N/M）`；工具钩子期并入该行（不另设行）。
- **注入可见**：流区折叠行 + Ctrl + H 查看窗（主窗全局键，弹窗期不生效）；live 与回放同款重现。

---

## 11. 模块开发者

进程内不需要 shell——既有 `ctx.events.on` + `mounts: ["hook:<type>"]` 即 API：本批新增三个可订阅点 `tool/pre-input`、`user/prompt-submit`、`session/start`（waterfall 两枚可阻断 + emit 一枚），配合既有 `tool/post-execute` / `agent/follow-up` / `agent/steering`。不另定义第二套 API。

---

## 12. 完整示例

**示例一：PreToolUse 拦截（bash 脚本）**——stdin 读 JSON，危险命令 exit 2：

```bash
#!/usr/bin/env bash
# scripts/guard.sh —— 拦截 rm -rf
input=$(cat)                                  # 读一行 stdin JSON
if echo "$input" | grep -q '"command"[^:]*:[^"]*"rm -rf'; then
  echo "rm -rf 被项目守卫拦下——请改用回收站或更窄的路径" >&2   # 理由走 stderr
  exit 2                                      # 退出码 2 = 阻断
fi
exit 0
```

```toml
[[hooks.PreToolUse]]
matcher = "^tool-shell__bash$"        # 只匹配 bash 工具（全名自带 ^$）
[[hooks.PreToolUse.hooks]]
command = "bash \"${OROSUS_PROJECT_DIR}/scripts/guard.sh\""
name = "危险命令守卫"                  # 说明——列表/状态行/拦截提示/注入行都显示它
product = "MyTeam"                    # 归属——多产品共装时辨识
timeout = 10                          # 秒；本条 10 秒杀树
```

**示例二：SessionStart 注入（python）**——stdout 回 JSON：

```python
#!/usr/bin/env python3
# scripts/onstart.py —— 只在全新会话注入项目知识
import json, sys
payload = json.loads(sys.stdin.readline())          # 读一行 stdin JSON
if payload.get("source") == "startup":              # matcher 同款判定（此处演示；matcher 写 "startup" 更简）
    print(json.dumps({"additionalContext": "项目知识：构建用 pnpm、测试跑 npx vitest run。"}, ensure_ascii=False))
# 退出码 0 + stdout 以 { 开头 = JSON 决策被解析
```

```toml
[[hooks.SessionStart]]
matcher = "startup"                   # 匹配 source 三值之一（无锚定子串命中）
[[hooks.SessionStart.hooks]]
command = "python3 \"${OROSUS_PROJECT_DIR}/scripts/onstart.py\""
name = "项目知识注入"
```

**示例三：单行内联（不写脚本文件）**——改参 + 拒收，任选语言或纯管道：

```toml
[[hooks.PreToolUse]]
matcher = "^tool-fs__write$"
[[hooks.PreToolUse.hooks]]
# node 单行：读 stdin、改参（追加一行尾注）回 JSON——updatedInput 只在 PreToolUse 有效
command = "node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({updatedInput:{...p.tool_input,content:String(p.tool_input.content||'')+String.fromCharCode(10)+'<!-- 已过守卫 -->'}}))})\""

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
# 纯 shell 内联：含「密码」的提交整条拒收（理由走 stderr、exit 2）
command = "grep -q 密码 && { echo 这条消息含敏感词，被提交守卫拒收 >&2; exit 2; } || true"
```
