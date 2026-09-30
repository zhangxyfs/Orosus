# mcp

- **提供**：MCP server 桥接工具（`mcp__<server>__<tool>` 三段名，§4.3）+ `mcp.catalog` 服务（管理面/菜单数据源）
- **消费**：无
- **配置**：`[mcp.servers.<id>]` —— `command`/`args`/`env`/`cwd`/`lazy`（stdio）或 `url`/`headers`/`transport`（`http` 缺省 / `sse`）；`timeoutMs`（调用超时，缺省 60 秒）；`accesses`（server 级放宽声明，缺省 fail-closed `kind: "all"`）；`deferred`（tool-search 按需加载）
- **uses**：`subprocess`、`network`
- 注：清单快照 digest 经 `mcp/manifest` 事件落会话日志

## 命令族（`/mcp`）

| 命令 | 作用 |
|---|---|
| `/mcp` | 列表：状态、工具数、失败原因首行、待确认指纹 |
| `/mcp add 名字 命令或URL` | 添加（写用户层 `~/.orosus/modules.d/mcp.toml`，整行命令守卫拆分，写完自动重载） |
| `/mcp remove / on / off 名字` | 删除与开关（项目/预装来源只停用不改来源——off 写用户层同名覆盖） |
| `/mcp trust [名字]` | 确认项目 `.mcp.json` 带来的 server（核对指纹前不连接） |
| `/mcp browse 关键词` / `/mcp install 名字` | 搜 MCP 官方注册表 / 一键装（缺密钥条目给手填模板；缓存 30 天断网可用） |

图形面：`/settings` →「MCP」管理面（列表四段行 / 详情六字段 / `Alt + K` 启停 / `d` 两拍删除 / `Alt + N` 添加·修改窗——手动/JSON 两页签）；斜杠菜单 `mcp : 名字` 区直达详情。

## 环境变量策略（m4-3c T10）

MCP 子进程（stdio 型 server）继承的环境变量 = **SDK 默认白名单 + 配置里显式写的 `env`**，两者合并、配置优先：

- 白名单（Windows 12 项）：`APPDATA`、`HOMEDRIVE`、`HOMEPATH`、`LOCALAPPDATA`、`PATH`、`PROCESSOR_ARCHITECTURE`、`SYSTEMDRIVE`、`SYSTEMROOT`、`TEMP`、`USERNAME`、`USERPROFILE`、`PROGRAMFILES`（非 Windows 为 `HOME`、`LOGNAME`、`PATH`、`SHELL`、`TERM`、`USER`）。这是官方 SDK 的安全缺省——宿主终端里的其余变量（可能带着密钥）不会自动漏给 server。
- **要更多环境变量请写配置**：在 server 条目里显式声明，值可以直接引用宿主环境（Orosus 配置层全局语法，零额外代码）：

```toml
[mcp.servers.github]
command = "npx"
args = ["-y", "@github/github-mcp-server"]

[mcp.servers.github.env]
GITHUB_TOKEN = "$ENV:GITHUB_TOKEN"   # 从宿主环境读取；也可直接写字面量
```

- 为什么不给「全继承」开关：MCP server 是第三方代码，环境变量是隐性凭据面（`AWS_*`、`ANTHROPIC_API_KEY` 等都走环境）——白名单 + 显式声明让「谁拿到了什么」始终可从配置读出。

## 项目 `.mcp.json` 信任门（T12）

只认当前工作目录这一层的 `.mcp.json`（Claude 定的社区标准格式）。项目带来的 server **首次不连**——启动时 toast 提示，`/mcp trust 名字` 核对指纹（前 8 位）后确认才连；换密钥不用重新确认（值不进指纹），改命令/地址必须重新确认（键名进指纹）。批准记录存 `~/.orosus/mcp-trust.json`（用户目录——不进仓库，恶意项目无法自带「已批准」）。同名优先级：手写配置 > 项目 `.mcp.json` > 预装。非 TTY 管道模式同样跳过不连（fail-closed）。

## 预装五件（T20，按需启动）

`memory`（跨会话知识图谱记忆）/ `context7`（库文档检索）/ `github`（要配 `GITHUB_TOKEN` 环境变量）/ `everything`（官方自检）/ `puppeteer`（浏览器自动化）。全部 `lazy` + `deferred` 双标记：**Orosus 启动时一个进程都不起**，第一次真正调用某个工具才连接（首次要等 npx 下载包，预算 60 秒）；预装件优先级最低（自己配置同名条目以你的为准）、只能停用不能删除、不走信任门。

- **`puppeteer` 的诚实标注**：导航、点击、抓文字、执行 JS 返回的都是文字，现在就能用；**截图返回的是图片，而工具结果通道目前是纯文本**——只会显示一行占位说明（预期行为非 bug）。「工具结果带图通道」在顺延台账里，那天做了截图自然复活。
- **预装工具与 tool-search**：预装工具整体走 tool-search 按需加载（搜索到才进请求）——tool-search **默认启用**（2026-09-30 起随预装批翻开，预装开箱即用）。显式关掉它（`[tool-search]` `enabled = false`）时预装仍出现在管理面/斜杠菜单（可启停查看），但不注册工具——关态下 deferred 标记不生效，几十个工具会灌爆每个请求的上下文。改完 `/reload` 生效。
- `github` 缺令牌时连接失败，详情页的 stderr 尾巴会带 server 自己的引导文案。

## 排障

- 连不上看 `/mcp` 列表的失败原因首行，详情页有「最后说过什么」（stderr 尾巴，最多 4KB）。
- Windows 上 `npx`/`npm` 等壳型启动器自动包 `cmd /d /s /c`（Node 对 `.cmd` 直 spawn 会 EINVAL）。
- 工具多的 server 清单自动翻页取全（同一游标二次出现或超 1000 页即停——防 server 死循环）。
- 断线自动重连一次（超时不重连——副作用操作重放两次就是事故）。
