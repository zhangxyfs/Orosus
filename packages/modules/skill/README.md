# skill

- **提供**：promptSection（可用技能摘要，order 0 区）+ 工具 `skill__load`（读技能全文）
- **消费**：无
- **配置**：无（扫描 `~/.orosus/skills/*` 与 `<cwd>/.orosus/skills/*`，用户级覆盖项目级同名）
- **uses**：`fs.read`
