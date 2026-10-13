# 已知问题与待修清单（Known Issues）

> 用途：记录使用/审查中发现的问题与可能需要修改的事项，作为持续追加的清单（不随日期归档）。
> 格式约定：每条一个编号（问题 N），字段含发现信息、现象、根因（附代码证据）、失效面、修复方向、状态。
> 状态取值：`待处理` / `修复中` / `已修复` / `不修（附理由）`。
> 分析口径备注：本清单中的根因分析若未特别注明，均为代码链路静态核对（行号以核对当日为准），未做运行时复现。

---

## 问题 1：todolist 应按代理隔离——主/子/孙代理各持一份专用清单

- **发现**：2026-10-11，用户（会话分析：ZCode 代码链路核对）
- **严重度**：中高（条件触发的决策误导 + 面板失真）
- **状态**：`待处理`
- **修复方向**：已由用户拍板——**主代理、子代理、孙代理各自拥有一份专用的 todolist**，互不覆盖（见「修复方向」小节）。

### 现象

todo 工具（`tool-todo__todo_write`）的状态在主对话与所有子/孙代理之间是**同一份共享闭包**，且写入语义为整表替换。任何一方调用都会整体覆盖其他方的清单：

1. **读路径误导主代理（最尖锐）**：子代理全完成 → 工具的「全完成自动清空」把共享状态清空 → 主代理查询（`todo_write` 省略 `todos` = 读当前表）看到「清单为空」，而工具描述明写 *Auto-cleared when ALL items are done* → 主代理可能推断**自己的**所有任务已完成、直接跳到收尾。子代理留下半截清单时同理：主代理读到一张自己没写过的表。
2. **TUI 任务面板失真（骗用户）**：子代理的写入经 `onWrite` 落**主会话**日志，面板读最后一条事件——后台子代理跑着跑着，「主代理任务清单」变成子代理的表。
3. **对称伤害子代理**：子代理查询时读到主代理（或其他并行子代理）的表，同样可能被带偏。

安全边界（已核对，不会更糟）：主代理的**对话上下文**不会被污染——模块事件 `tool-todo/write` 不被 `deriveMessages` 投影进模型消息；系统提示词中的 todo 引导段为静态文本。共享状态只有经「主/子代理主动查询」重新进入各自上下文时才产生误导。

### 根因（代码证据）

- todo 状态存于模块激活时创建的闭包变量，全进程仅一份：`packages/modules/tool-todo/src/index.ts:20-21`（`createTodoTool` 的 `state: TodoState`）。
- 子代理工具面抄的是主图里的**同一个工具对象**（按引用，非新建实例）：`packages/core/src/subagent/runner.ts:491-516`（`deps.graph().tools.list()` 过滤后原样 `tools.register(...)`）。
- 内置剥离名单未覆盖 todo：`packages/core/src/subagent/runner.ts:66`（`SUBAGENT_HIDDEN_TOOLS` 目前仅 `skill__load`）。
- `onWrite` 在模块激活时绑定**主 harness 的 session store**，子代理写入落主会话日志：`packages/core/src/kernel/activate.ts:348-357` + `packages/modules/tool-todo/src/index.ts:66`。
- 面板投影读最后一条 `tool-todo/write` 事件：`apps/cli/src/modules-ui.ts:209`（`.at(-1)` 取末条；逐条投影本体 `apps/cli/src/todo-panel.ts:11-22`）。
- 引导文案反而提高碰撞概率（鼓励并行期间多条 in_progress）：`packages/modules/tool-todo/src/index.ts:14-17`。
- 文档/测试零覆盖：`tests/subagent/` 与 `doc/06-core-tool-subagent.md`、`docs/superpowers/specs/modules/subagent.md` 均无「子代理 + todo」的记述或用例。

判定：属设计疏漏而非拍板——内核已有「抄面会出问题的工具」处理机制（`SUBAGENT_HIDDEN_TOOLS`，`skill__load` 因配套清单不可见被剥），todo 属同类（会话级状态、无执行上下文隔离）但未被列入。

### 修复方向

**拍板（用户，2026-10-11）：按代理隔离——主代理、子代理、孙代理各一份专用 todolist。**

实现要点（供开工时展开，未定案）：

- **状态分桶**：利用 runner 已有的执行上下文 ALS（`packages/core/src/subagent/runner.ts:77` 的 `execContext`，含 `agentId` 与 `depth`）为 todo 状态分桶——主对话一份、每个子/孙代理各一份。需解决「模块闭包看不到内核 ALS」的接线问题（候选：经 ToolContext 传入执行身份，或模块侧注册按上下文取状态的读口）。
- **落日志归属**：子代理的 `onWrite` 应落子代理自己的会话文件（`agents_<编号>/session.jsonl`）而非主会话；载荷建议带 `agentId`。
- **面板投影**：`todo-panel` 按 `agentId` 区分展示（主清单照旧，子代理清单折叠或在 agent 组行展示）；至少不得再被子代理写入整体顶掉主清单视图。
- **提示词口径**：子代理工具描述/系统提示明确「这是你自己的清单」，避免模型误以为是全局任务板。
- **测试兜底**：补「子代理写 todo 不改主代理清单」「面板投影不被子代理顶掉」「全完成清空只清自己」三个方向的最小用例（`tests/subagent/` + `apps/cli/src/todo-panel.test.ts`）。

被否掉的替代方案（留档）：把 `tool-todo__todo_write` 加入 `SUBAGENT_HIDDEN_TOOLS`（一行最小修，子代理一律不用）——与拍板方向冲突（牺牲长任务子代理的自我跟踪能力），弃。

---

## 问题 2：web 端子代理与 /btw 详情从弹窗改为右侧分栏 + 选项卡（含 /tasks 改造）

- **发现**：2026-10-11，用户
- **类型**：体验优化（非缺陷——现状能用，交互形态不理想）
- **状态**：`待处理`
- **拍板**：用户已给完整目标形态（见下），细节以本节复述为准；另有二轮补充（2026-10-12，见「二轮补充」节）。

### 现状（代码证据，行号以核对当日为准）

- `/tasks` 命令 → 弹出任务面板：`apps/cli/src/web/assets/app.js:170-171`（mark 路由 `tasks` → `UI.openTasksPanel()`），命令描述「子代理任务列表（选择进消息查看窗…）」在 `app.js:1760`——选中子代理后进**消息查看窗**（弹窗）。
- `/btw` → 侧问小窗（弹窗）：`app.js:101-102`（`UI.btwSetQuestion`）、`app.js:2117`（`UI.btwFrame`）。
- 右侧卡片 = 常驻右栏「运行状态 + 任务清单」两节：任务清单投影 `todo-list/todo-count/todo-bar`（`app.js:2224-2232`）；已有**收缩悬浮卡**形态（`tf-list/tf-count`，`app.js:2163-2164`）——即悬浮条可复用，不必新造。

### 目标形态（用户拍板，2026-10-11）

1. **弹窗改分栏**：打开子代理详情或 btw 详情时不再走弹窗——右侧卡片（运行状态 + 任务清单整个右栏）先隐藏，主代理 todolist 转为**悬浮条**样式继续显示；「会话列表以外」的区域左右分半：左半 = 主对话（消息流 + composer）原样不动，右半 = 详情分栏。比例默认 **50/50，分隔条可拖拽**。
2. **选项卡条**：右半顶部挂选项卡条（参考 Kimi Code 侧栏形态）——可同时开多个选项卡（各带关闭 ×，另有 + 入口），**同一时刻只显示一个选项卡内容**（显示互斥、打开并存）；类型可扩展（以后会有更多种类）。
3. **子代理选项卡**：预览该子代理详情页（执行过程/会话内容）；该子代理**自己的 todolist** 以悬浮条样式显示在分栏内——**依赖问题 1 的按代理隔离落地**。
4. **btw 选项卡**：btw 消息渲染窗口 + 窗口下方一个消息发送框（与主 composer 一致，但**去掉权限模式、模型选择、思考级别三个按钮**，保留贴图、@ 等其余交互）；btw **不要 todolist**。（二轮补充升级为多轮 + 只读工具 + web/CLI 边界分叉——见「二轮补充」节。）
5. **/tasks 改造**（2026-10-11 二轮修正）：`/tasks` 不再弹任务列表面板，也**不是**单一「tasks 选项卡」——执行 `/tasks` = 打开右侧分栏，并为当前每个子代理各开一个子代理选项卡（有几个开几个，**选项卡条即清单**，列表视图取消）。
6. **主对话子代理条目可点击**：主对话消息流中的子代理条目（agent 组行）改为可点击——点击某子代理 → 右侧分栏显示其详情：未开则新开选项卡，已开则**直接切到该选项卡**（open-or-switch，不重复开）。
7. **关闭行为**：分栏关闭（选项卡全关/关掉分栏）后右半收回，右侧卡片恢复原状。

### 二轮补充（2026-10-12）：分栏入口 + btw 多轮化（web 版边界与 CLI 分叉）

1. **分栏入口**：右上角状态栏行（更新 / 设置 / 帮助 / 更多 / 颜色 / 标注）末尾新增一个入口按钮——点击打开右侧分栏（与 `/tasks`、点击子代理条目并列的人工入口）。
2. **btw 多轮化（web 版）**：btw 选项卡内可连续追问（多轮对话），不再是单轮。每轮重取最新主对话历史 → 对主代理「一直有感知」。现状澄清：用户所指「会话感知」= 既有历史继承机制——btw 默认带主对话全部上下文、且**只能感知主对话**（看不到子代理），但它是提问瞬间的快照、不跟随演进（plans/2026-10-03-m5-btw.md §八「快照语义」）；多轮 + 每轮重取 = 感知持续刷新。「只感知主对话」的边界保持不变。
3. **btw 工具面（web 版）**：只放开三个只读工具 `tool-fs__read` / `tool-fs__grep` / `tool-fs__glob`，其余一律不给（全部 veto）。
4. **web 与 CLI 边界分叉（已确认可行）**：CLI 维持现状（单轮、无工具、零落盘）；web 版升级为上述形态。架构依据：两者共享面仅 `buildBtwRequest` / `BTW_ROLE_PROMPT` / `BTW_USAGE_HINT` 三个纯函数/常量（apps/cli/src/btw-cmd.ts），状态机各自独立（CLI `openBtw` 进程级单件 vs web `runBtw` 每会话 WeakMap，apps/cli/src/web/cmdrouter.ts:144-186）——分叉点干净，互不牵连。

**方案备忘（实施时需拍板）**：

- m5-btw 方案 D1 早预留此口子：「要只读工具或多轮时再回」runner fork 路线（plans/2026-10-03-m5-btw.md）——runner 现已建成且条件齐备（`allowedTools` 可白名单三只读工具；纯只读代理不占写闸，runner.ts:519-521）。但 runner 路线与两条原拍板冲突：进 /tasks 花名册（违 D5「btw 不进名册」）、落子代理会话文件（违 D6「零落盘」）——走 runner 需重拍这两条（或接受改口）；备选 = 轻量多轮直调（自拼循环 + 工具注册表，不经 runner），保住零落盘、不进名册，代价是自管轮次保险丝与审批接线。
- 共享件需参数化：`BTW_ROLE_PROMPT` 按工具面分版（无工具版 / 只读工具版），`buildBtwRequest` 加工具面与多轮形态选项——CLI 继续用无工具单轮形态，避免分叉后语义漂移。
- lastBtw 归档形态随多轮调整：从单条问答变一串问答（无参回看的展示形态随之改）。
- **问题 3 交叉（2026-10-12 补）**：btw 放开工具后即进问题 3 的共享闭包面。三工具逐一核对——`tool-fs__grep`/`tool-fs__glob` 无状态不受影响；`tool-fs__read` 会写两份共享记忆：`readState`（写前比对守卫，tool-fs/src/index.ts:428）与 `lastRead`（同路径 mtime 去重提示，:368）——btw 的读会进主对话的写守卫记忆（「本会话读过」前置被 btw 满足；mtime 混源双向干扰，误拦向安全）。**两条路线同暴露**：runner 与轻量直调都复用主图工具对象（工具工厂不外曝、无法另铸无共享实例），不是选 runner 才有。依赖序：问题 3 的通用修复（执行身份进 ToolContext + 状态分桶）先行或同批 → btw 工具面天然干净；否则须接受该稀释，或给 tool-fs 开实例化能力（动模块面，成本更高）。

### 实现要点（供开工时展开，未定案）

- 分栏容器与拖拽分隔条（默认 50/50，比例持久化可后置）；选项卡条组件按「类型 + id」注册 tab，内容区单实例互斥渲染。
- 右侧卡片隐藏/恢复与悬浮条切换：复用现有收缩悬浮卡（`tf-*`）形态；主 todolist 悬浮条与子代理 todolist 悬浮条需带归属标识（主 / agentId）。
- btw 选项卡的发送框复用主 composer 组件裁掉三按钮；发送走既有 btw 旁路通道（不进主对话）。
- /tasks 数据源不变（既有 roster 端点），呈现层从列表面板改为**按子代理批量开 tab**；主对话子代理条目加点击路由（open-or-switch 语义：按 agentId 查已有 tab，命中即激活，未命中即新建）。
- 原 tasks 面板的审批批/拒提示（「等审批行选择即可批/拒」）实际指主消息流内联审批行——面板移除后审批入口不受损，但需回归确认。
- 待定细节：当前无任何子代理时执行 `/tasks`——倾向打开空分栏（选项卡条空态提示），不弹提示框。
- 前置依赖：问题 1（按代理隔离的 todolist）先行或同批落地，否则子代理选项卡的「自己的 todolist 悬浮条」无数据来源；btw 多轮 + 只读工具面另依赖问题 3（共享闭包分桶）先行或同批——`tool-fs__read` 的守卫记忆与主对话同源（见二轮补充备忘「问题 3 交叉」）。

---

## 问题 3：共享闭包审计——除 todo 外还有 4 个工具的主/子代理状态同源（goal 最重）

- **发现**：2026-10-12，用户提出怀疑方向，ZCode 全模块审计确认
- **严重度**：高（goal 可劫持主对话循环）/ 中（shell cwd 漂移、fs 守卫稀释、search reveal 串台）
- **状态**：`待处理`
- **修复方向**：已由用户拍板（2026-10-12）——**通用机制路线**（见「修复方向」节）。
- **与问题 1 的关系**：同根因。机制层面一个不漏的解释——runner 抄面抄的是**工具对象引用**（runner.ts:506-515，复用实现本身），而各模块把「会话语义状态」放进了 `activate()` 闭包；ToolContext 无 per-agent 身份口，工具执行期拿不到「我在替谁跑」，故无分桶。问题 1 若把修复做成通用机制（执行身份进 ToolContext + 状态按身份分桶），本条 4 项同批受益。

### 病灶清单（主/子代理共享同一份可变闭包状态）

1. **tool-goal `store`（最重）**：`createGoalStore` 在 activate 闭包（tool-goal/src/index.ts:135），create/get/update 三工具 + 系统提示段 + 续跑轮全挂它上。子代理调 `tool-goal__create/update` → ①主对话系统提示的 goal 段（order 22，**动态 getter**，index.ts:137）下轮请求即被改写；②主循环欲停时 `goalFollowUp`（index.ts:138，订阅主 bus 的 agent/follow-up）会为**子代理建的目标**注入续跑消息——主对话被劫持自动续跑。比 todo 更重：todo 只骗读，goal 驱动循环。
2. **tool-shell `ShellMemory.lastWorkdir`（cwd 漂移）**：bash 工作目录记忆是激活闭包单件（tool-shell/src/index.ts:27，:307 注入）——每条 bash 从 `memory.lastWorkdir ?? process.cwd()` 起跑（:32）、跑完回写（:126）。子代理 `cd /x` 后主代理的下一条 bash 就从 /x 起跑（反之亦然）——静默错目录执行。附带同闭包的 `JobRegistry`（后台作业）：作业 id/output/kill 全进程共享（跨代理互杀/互查，进程级语义尚可辩护），但作业完成通知只汇入**主对话**的 followUp 收集点（订阅在 tool-shell/src/index.ts:312，`drainNotifications` 本体在 jobs.ts:306）——子代理起的后台作业，完成通知进主对话 steering。
3. **tool-fs `readState`（写守卫记忆稀释）**：read/write/edit 三工具共享同一 ReadState（tool-fs/src/index.ts:718-720），承载「本会话读过没有」与写前 mtime/内容比对（writeGuard :328-351；edit 前置提示「本会话尚未读取过该文件」:569）。共享后果：子代理的 read 替主代理满足了 edit 前置（反之亦然）；跨代理交错读写同文件时双向干扰——可误放行（他代理读过旧版即放行本代理的覆盖）也可误拦截（安全向）。
4. **tool-search reveal 状态（工具面串台）**：meta 工具闭着 `ctx.tools`（tool-search/src/index.ts:133 activate 传入，工厂签名 :48），调用即 `tools.reveal(...)` 改**主图共享注册表**（:101）。子代理工具面含此工具（SUBAGENT_HIDDEN_TOOLS 只剥 skill__load）——子代理 search 一次，主对话下一轮的工具面与目录段（order 21 getter）即被改写。runner 注释「子代理语境没有 tool-search 加载机制」的机制旁路担忧在 reveal 这半边实际成立。
5. **tool-todo**：即问题 1，不赘。

### 查过没事的（留档免重查）

**全项目扫尾（2026-10-12 二轮，应用户要求扩展到四类面）**——结论：**同严重度病灶没有新增**，病集中在「模型可调用的会话语义状态」这一类（即上文 5 项）。扫描覆盖面与判定：

- **web 多会话拓扑（关键前提，安全）**：每个 HostedSession 独立 `createHarness`（apps/cli/src/web/hosted.ts:207）→ 模块 activate 闭包按会话隔离，**不跨 web 会话共享**；共享只发生在「同一会话内主 vs 子/孙代理」。文件级单例因此只须在进程级语义下评估。
- **文件级可变单例（modules/core/cli 全量过一遍）**：mediapipe/imaging 的 Worker 池（seq 键控无状态作业）、vision 摘要去重（path 键控 in-flight dedup）、catalog/modelsDev memo（mtime 键控）、turndown 懒初始化、i18n 全局 locale、事件 id 序发生器、CLI 侧 REPL/面板/渲染态——全部为进程级语义、纯缓存或 UI 单例（web 路径不经 CLI 单例；btw 的 btwAbort/lastBtw 仅 CLI 路径，web 用 cmdrouter 每会话 WeakMap——刻意会话级化，注释在案）。
- **非工具模块 activate 闭包**：hooks runSeq（计数器）、compaction 退避/熔断（主会话语义——子代理无压缩）、session-tree depthCache（缓存）、mcp 连接与 lazyStarts memo（按图隔离=按会话）、multilang（静态）——干净。
- **动态 promptSection getter（4 处）**：goal（order 22）与 search 目录（order 21）读**子代理可变**的共享状态——已分别登记为病灶 1/4；mcp（order 20，读 server instructions，仅懒连接可变，模型不可调）与 tool-peers（order 5，读 MEMORY.md，跨会话共享工作区记忆=工具本意）——设计内。
- **logEvents 会话捕获面**（模块 ctx.session.append 恒落主会话 store）：todo/goal 已登记；hooks/run、hooks/input-rewrite（子代理转发事件带身份落主会话——刻意审计 trail，D18）、approval/*（主闸设计内）、mcp/manifest（激活期）、compaction（仅主循环）——设计内。
- **approval sessionMemory**（「本会话不再询问」记忆）：主闸单例，子代理转发审批与主对话共享同一份——同用户同闸，判定设计内（但值得知道：子代理里选了「不再询问」对主对话同样生效，反向亦然）。

**首轮留档**：

- **skill `loaded`**（加载去重集）：skill__load 已在 `SUBAGENT_HIDDEN_TOOLS`（runner.ts:66）剥离，子代理无调用路径——**既有正确处理先例**，问题 1 的最小修参照它。
- **tool-shell JobRegistry / tool-web sticky（provider 探测降级态）/ tool-peers summaryCache（sid+mtime 键控）/ mcp 桥接连接**：进程级语义或纯缓存，共享属合理设计（作业通知汇流点除外，见上 2）。
- **tool-ask / tool-media / tool-fs__glob/grep**：无闭包可变状态。
- **tool-subagent 花名册**：协调点本体，共享即设计。
- 内核侧无直接注册的生产工具（defineTool 仅测试用）。

### 修复方向（已拍板 2026-10-12：通用机制）

**用户拍板：走一劳永逸的通用机制——执行身份进工具执行面，会话语义状态按身份分桶。**

- **机制形态**：工具执行上下文带上执行身份（主对话 = 主；子/孙代理 = agentId），病灶 1-4 的会话语义状态（todo 清单、goal store、shell cwd 记忆、fs readState/lastRead）按身份分桶——每个代理各持一份；skill `loaded` 同批审视。search reveal 语义特殊（改的是主图工具面而非私有状态），单独定策略（倾向子代理禁 reveal 或 reveal 作用域化，实施时定）。
- **受益面**：问题 1（todo 每代理一份）由本机制直接实现；问题 2 的 btw 工具面（tool-fs__read 守卫记忆）随之干净；后续新工具默认安全（状态跟身份走，不再依赖作者记得分桶）。
- **被否方案（留档）**：逐病灶修（goal/todo 进剥离名单 + shell/fs 分键 + search 只读化）——用户明确选一劳永逸路线；不修机制则将来新工具还会再犯。
- **实施注意**：分桶键 = agentId，主对话用固定键；身份的注入缝二选一——ToolContext 加字段（动 packages/contracts 契约）或注册期 per-agent 闭包注入（动内核 runner），按改动面与兼容性实施时定；子代理会话文件/花名册本就按代理隔离，不在本机制范围内。

---

<!-- 新问题按「问题 N」追加于此线之下 -->
