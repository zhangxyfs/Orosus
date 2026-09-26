# tool-shell

- **提供**：工具 `tool-shell__bash`（approvalRule `tool-shell__bash(${command})`，matchesRule 支持后缀 `*` 前缀匹配）
- **消费**：能力 `fs`（`writeOutputTo` 落盘走 fs，不直接写文件——消费方范例）
- **壳解析**（win32）：Git Bash 优先（`Git\bin\bash.exe`，启动自带 `/usr/bin` 前置，POSIX 命令直通），未找到回落 cmd.exe（`shell:true`）；POSIX 平台恒 sh。SystemRoot 下的 bash.exe 是 WSL 桩，探测时排除。
- **cmd 方言护栏**：回落 cmd 时，POSIX 命令（head/grep/sed/awk/…）执行前拦截并给替换建议（前台/后台同拦，不真跑）；护栏漏网的「命令不存在」在退出时按报错文案就地翻译；退出码非 0 但有产出时标注「先读输出再决定重试」。
- **配置**：无（环境变量 `OROSUS_TOOL_SHELL=cmd` 显式锁定回落——测试注入位 + 逃生口；`=bash` 走探测）
