# Orosus contracts API 参考（机器生成——勿手改）

> 给模块开发者看的完整接口参考：每个导出的含义、参数（含范围与缺省）、返回与示例，
> 与 `packages/contracts/src/*/index.ts` 的注释同源生成（`pnpm gen-docs`；docs:check 门禁验同步）。
> 快速上手看 [module-walkthrough.md](../module-walkthrough.md)；帮人写模块的 AI 先读 [extension-catalog.md](../extension-catalog.md)。

| 域 | 内容 | 文件 |
|---|---|---|
| module | 模块 API 主面——defineModule、ModuleContext 全口（工具/命令/提示词段/卡片）、CommandUi 交互（弹窗/控件窗/注入）、LlmPort、SettingsService 与 HostInfo 读面、事件与信任门语义。 | [module.md](module.md) |
| tool | 工具契约——defineTool 两阶段（resolveExecution 声明 / execute 副作用）、Access 资源声明、审批规则与结果形状。 | [tool.md](tool.md) |
| provider | 提供商适配器契约——StreamFn 流式口、消息与工具规格形状、槽位解析辅助。 | [provider.md](provider.md) |
| fs | 文件系统能力契约（FS 能力槽的接口形状）。 | [fs.md](fs.md) |
| home | 宿主数据目录解析（OROSUS_HOME 覆盖）。 | [home.md](home.md) |
