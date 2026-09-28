# skill

- **提供**：promptSection（可用技能摘要，order 0 区）+ 工具 `skill__load`（读技能全文）+ 服务 `skill.catalog`（菜单/管理面目录，现读重扫）+ `skill.resetLoaded`（去重集重置口，宿主 compact 完成点调用）
- **消费**：无
- **uses**：`fs.read`
- **扫描目录**（弱→强，后入表者胜 = 项目压用户 + 品牌压通用；共五轨）：`bundled` 内置轨（模块自带 `bundled/` 随包分发，垫底——用户/项目同名技能可覆盖出厂件）→ `~/.agents/skills` → `~/.orosus/skills` → 项目 `.agents/skills`（从 cwd 逐层向上到 git 根，就近覆盖）→ 项目根 `.orosus/skills`（品牌目录只认项目根与用户级）；每子目录一个 `SKILL.md`（frontmatter 手写行解析）
- **frontmatter**：`name` 必需；`description`（缺省空串）/`when_to_use`（简单说明，菜单详释第 3 行）与 `disable-model-invocation`（值恰为 `true`——不进模型清单，用户手动路径不受限）可选；未知键丢弃（宽松派）
- **清单预算**：单条 description 截 250 字符；技能段总预算 4000 字符，超限整段降级为仅技能名列表
- **skill__load**：accesses 按命中技能真实路径；执行时重扫（会话中新放技能指名即加载）；运行时去重（重调回确认句），compact 后由宿主经 `skill.resetLoaded` 清零
- **停用**：config `disabled: string[]`（按技能名）——停用者不进模型清单、不进斜杠菜单、load 拒绝并带出路文案；`/settings → 技能` 管理面全收（含停用与仅手动者）
- **配置**：`[skill]` 节——`disabled` 数组键（宿主 `/settings → 技能` Alt + K 写回）+ 测试注轨键（`userAgentsDir` / `userOrosusDir` / `projectAgentsDirs` / `projectOrosusDir` / `bundledDir`）
