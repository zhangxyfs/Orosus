# Orosus 路线图（之后做什么——单一事实源）

> **维护纪律**：每批收官/立项/排期变更时更新本文件（commit 留痕）；细节不在本文展开，链接到对应方案书/台账/调研。
> **状态快照**：2026-09-19 —— M4-2 已收官（508）；M4-2.5 方案 v1 待审；代码态 511 测试四门全绿，v31、D1–D49、批次 16。

## 排队中（按当前顺序）

| 顺序 | 批次 | 内容 | 状态 | 方案/出处 |
|---|---|---|---|---|
| 1 | **M4-2.5 容量与多模态** | read 缺省窗口+mtime 去重 / 截断头尾 3:1 / readTitle 预算 / /compact 立即执行+/summary / **图片真实喂图**（ContentPart image，V.2 销账） | **方案 v1 待审**（511→542） | `plans/2026-09-19-m4-2-5-capacity-multimodal.md` |
| 2 | **M4.5 子代理小里程碑** | 第一档纯外部迷你 loop（explore 只读型，零新核心口）；bash 后台执行+任务管理四件套（run_in_background/读输出/查杀/wait+完成通知）；第二档（ctx.tools.invoke 编排）待核心口入主文档 | 既定（master plan 决策点⑤：M4-2 之后启动，不等 M4-3；被 M4-2.5 顺延一位） | master plan Part V.1 |
| 3 | **M4-3 分发主体批** | npm 模块分发 + `module add` + 声明式内容模块 + L1（SES Compartment，先一周 spike）；C2 事件 schema 版本化 / C4 用户文档 / C3 i18n 标记；overlay 权限门与目录 hash 信任粒度重估；生态搭车池（OAuth/重试/keychain/skills/.agents 等） | 未立项（独立计划书，L1 spike 先行） | master plan Part IV |
| 4 | **M5 候选池**（TUI 推荐为首项——见下） | 见下节 | 未立项 | master plan Part V.1 |

## M5 / 独立里程碑候选

- **TUI 框架化（推荐 M5 首项，2026-09-19 排期讨论定）**：kimi-code 形态完整界面（全屏接管、流式重绘、编辑器/picker/状态栏；Ink / pi-tui / 自写三选一）。技术前置已成熟（D45 旁路通道 ✅ + CommandUi 接缝 ✅），唯一缺选型 spike（一周）。排在 M4.5/M4-3 之后的理由是性价比（readline 层已榨干大半）而非技术依赖——用户可提前。
  - **前置小批可插队**：B5 第 2 层 raw-mode（上下键菜单/Esc 取消/厂商目录滚动翻页/流式清屏重绘——自写小型组件零依赖，几天量级；顺带解锁 Esc 取消审批询问、@path#L10-L20 行范围补全）。
- 多前端服务器（headless server + CUI/Web 前端，dsh 形态；TUI 是其第一前端；前置：WorkspaceLease 跨会话写锁——Reasonix 借鉴）。
- 用户态 hooks；企业面；声明式插件工程细节（随 `module add` 设计）。
- L2（子进程隔离 + 出口代理 + OS 兜底 bubblewrap/seatbelt）——M4-3 的 L1 之后独立批。
- sansheng-liubu（三省六部）多智能体编排旗舰——subagent 之后立项。
- 会话内分支树/undo；全文索引/搜索；文件历史快照/回滚；thinking 回流——各见 master plan V.2。

## 遗留台账（不主动立项）

- **V.2 远期池剩余**（`plans/2026-09-18-m4-master-plan.md` Part V.2）：B13 审批拒绝带反馈（CommandUi 扩契约——M4-2.5 明示不顺带，下个契约窗口评估）、Markdown 复杂版（引库+高亮+表格，随 TUI）、--input-format 双向流、todo stale 提醒、ask 指纹去重、金额折算、/paste Alt+V 按键（raw-mode）、每日 stats JSONL、会话信封短键名（format:2）。
- **V.3 条件触发**：parseModelsResponse 非标形状、跨后端 resume 探测、动态依赖调度。
- **V.4 暂缓/备选**：**zstd/gzip 日志压缩**（日志调研 P4 升级为正式候选——引依赖需单独拍板，Node 内置 gzip 零依赖路线与 zstd 选型合并评估）、C1 工具结果外溢剩余面（read 侧 M4-2.5 T0 部分销）、启动期自动 GC（永不做——「降级必须吵闹」）。
- 模块×六家缺失盘点少数派（等真实需求）：EnterPlanMode 计划模式、LSP 工具、notebook、git worktree 隔离、持久 shell 会话、Goal 工具族、ToolSearch 按需加载、web search/fetch 模块（生态项随 M4-3）。

## 已完结里程碑（存档索引）

| 里程碑 | 内容 | 收官态 |
|---|---|---|
| M1/M2/M3（+两补强） | 内核三件+模块生态+规模化 | v17–v29，详见 `specs/design-decisions.md` 批次 1–14 |
| M4-1 存储与日志 | D45 断流+旁路 / D46 分桶+懒写 / D47 prune | v30，批次 15，402→444 |
| M4-2 体验批 | 批 A T0–T11 + 批 B T12–T22（todo/ask/审批硬化//paste/系统提示词/markdown/--print/@文件//context/补全等） | v31，批次 16，444→508；走查追加修复（清屏/fork 回显//permission 直达//yolo）→511 |
