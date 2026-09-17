# approval 模块

- **提供**：无能力 key——纯拦截方（`tool/pre-execute` waterfall 首个消费方）。
- **消费**：工具两阶段声明（`accesses`/`approvalRule`/`matchesRule`，§6.3）、`ctx.ui` 询问口（D35 M3 修订）、`ctx.session.append`（审批事件）。
- **贡献**：`approval__permission` 命令（内建别名 `/permission`，T3）；`approval/requested` / `approval/resolved` 日志事件。

三档权限模式（D36 + 2026-09-17 修订）：`ask-always`（仅只读放行）/ `ask-risky`（出厂默认，常规读写放行、subprocess/敏感路径写/危险命令询问、network 放行）/ `never`（放行一切，**唯危险命令仍询问**）。用户规则（allow/ask/deny，全名/后缀通配/带参 pattern）优先于模式基线；"本会话始终允许"为会话内存记忆，危险命令永不记忆。危险命令识别走 vendored 纯 TS bash AST 解析器（`src/vendor/tree-sitter-bash`，MIT，源自 kimi-code）+ 遍历策略（`src/dangerous.ts`）——预算 500ms/1 万节点，解析失败或降级一律 fail-closed 询问；Windows cmd 方言双保险 pattern。出厂 `[approval] required = true`（§10 安全护栏）。
