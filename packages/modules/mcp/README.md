# mcp

- **提供**：MCP server 桥接工具（`mcp__<server>__<tool>` 三段名，§4.3）
- **消费**：无
- **配置**：`[mcp.servers.<id>]` —— `command`/`args`/`env`/`cwd`（stdio）或 `url`/`headers`（HTTP）；`timeoutMs`（调用超时，缺省 60 秒）；`accesses`（server 级放宽声明，缺省 fail-closed `kind: "all"`）；`deferred`（tool-search 按需加载）
- **uses**：`subprocess`、`network`
- 注：清单快照 digest 经 `mcp/manifest` 事件落会话日志（计划补空白的 digest 落点）

## 环境变量策略（m4-3c T10）

MCP 子进程（stdio 型 server）继承的环境变量 = **SDK 默认白名单 + 配置里显式写的 `env`**，两者合并、配置优先：

- 白名单（Windows 12 项）：`APPDATA`、`HOMEDRIVE`、`HOMEPATH`、`LOCALAPPDATA`、`PATH`、`PROCESSOR_ARCHITECTURE`、`SYSTEMDRIVE`、`SYSTEMROOT`、`TEMP`、`USERNAME`、`USERPROFILE`、`PROGRAMFILES`（非 Windows 为 `HOME`、`LOGNAME`、`PATH`、`SHELL`、`TERM`、`USER`）。这是官方 SDK 的安全缺省——宿主终端里的其余变量（可能带着密钥）不会自动漏给 server。
- **要更多环境变量请写配置**：在 server 条目里显式声明，值可以直接引用宿主环境（Orosus 配置层全局语法，零额外代码）：

```toml
[mcp.servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp.servers.github.env]
GITHUB_TOKEN = "$ENV:GITHUB_TOKEN"   # 从宿主环境读取；也可直接写字面量
```

- 为什么不给「全继承」开关：MCP server 是第三方代码，环境变量是隐性凭据面（`AWS_*`、`ANTHROPIC_API_KEY` 等都走环境）——白名单 + 显式声明让「谁拿到了什么」始终可从配置读出。
