# MCP server 推荐清单

> 出厂预装之外，想找更多 MCP server 时的起步参考。**每条只是示例配置，仅参考不构成推荐**——版本与包名以
> `/mcp browse 关键词`（查 MCP 官方注册表）的实时结果为准；本页写的是方向，不是背书。
>
> 两类不列：**文件读写类**（与内置 Read / Write / 编辑工具重复）、**网页抓取类**（与内置 Web Fetch / Web
> Search 重复）——装了也是功能重复，白占上下文。

预装五件（memory 记忆 / context7 文档检索 / github / everything 自检 / puppeteer 浏览器）开箱即用、
按需启动、不用时零进程——详见 `/settings` →「MCP」。下面是预装之外的三个方向。

## 数据库类

让模型直接查你的库（只读查询为主，写操作记得配审批规则）。

```toml
# ~/.orosus/modules.d/mcp.toml —— PostgreSQL（官方参考实现）
[mcp.servers.postgres]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost:5432/我的库"]
```

- 连接串里带密码时建议走 `$ENV:` 引用（如 `args = ["…", "postgresql://user:$ENV:PGPASS@host/db"]`——Orosus
  配置层全局语法），不要把明文密码写进会被同步的配置里。
- SQLite / MySQL 等同族 server 在注册表搜 `/mcp browse sqlite`、`/mcp browse mysql`。

## Playwright 浏览器类（比预装 puppeteer 更全的自动化）

微软官方的 Playwright MCP——导航、点击、填表、无头浏览器截图（截图受「工具结果暂只支持文本」限制，
显示占位说明——与预装 puppeteer 同款边界）。

```toml
[mcp.servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp"]
```

- 首次使用会下载浏览器内核（几分钟）；不需要时 `/mcp off playwright` 关掉即零开销。

## 进阶记忆类（比预装 memory 的知识图谱更进一步）

预装 memory 是官方知识图谱（实体-关系-观察三元组）。要跨会话长期记忆 + 时间感知检索，看 Graphiti 一族：

```toml
[mcp.servers.graphiti]
command = "uvx"
args = ["graphiti-mcp"]
# 需要图数据库与 LLM key——按所实现例在 env 里显式声明（$ENV: 引用宿主环境）
```

- 这一类普遍要配 Neo4j / API key，属于「先读它的 README 再装」的档位——注册表实时清单见 MCP 官方目录。

## 装完之后

- `/settings` →「MCP」看红绿灯；连不上时详情页有「最后说过什么」（stderr 尾巴）。
- 工具多不用怕——预装与声明 `deferred` 的 server 工具走按需加载（tool-search 搜到才进请求）。
- 项目自带的 `.mcp.json` 首次会要求 `/mcp trust` 确认（指纹核对），确认一次永久可用。
