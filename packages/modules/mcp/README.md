# mcp

- **提供**：MCP server 桥接工具（`mcp__<server>__<tool>` 三段名，§4.3）
- **消费**：无
- **配置**：`[mcp.servers.<id>]` —— `command`/`args`/`env`（stdio）或 `url`（HTTP）；`accesses`（server 级放宽声明，缺省 fail-closed `kind: "all"`）
- **uses**：`subprocess`、`network`
- 注：清单快照 digest 经 `mcp/manifest` 事件落会话日志（计划补空白的 digest 落点）
