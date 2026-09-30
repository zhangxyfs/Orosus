import type { ServerToolMeta } from "./bridge.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** T20（m4-3c）：预装五件 MCP server——按需启动（lazy：启动零进程，首次调用才连，60s 首启预算
 *  给 npx 下载）+ 整体 deferred（工具进 tool-search 目录按需加载，几十个工具不撑爆上下文）。
 *  优先级最低：用户/项目同名条目整体让位；只能停用不能删除；不走 T12 确认门（非项目带来）。
 *
 *  静态工具清单（manifest）：lazy 意味着启动时不连 server——但 tool-search 目录与提示词清单行
 *  需要工具名。清单按当前主流版本手工钉版；首次连接后取实况 listTools **把真 inputSchema 就地
 *  补进已注册工具**（2026-09-30——静态清单没 schema，模型看不到参数面会瞎发参数吃 server 校验
 *  错）；名单漂移双向报告维持优雅降级（实况多出的无法后补注册、静态名实况不存在时调用得到
 *  server 的 Unknown tool——非崩坏）。 */

export interface PreloadDef {
  name: string;
  command: string;
  args: string[];
  /** 静态工具清单（catalog/deferred 注册用） */
  manifest: ServerToolMeta[];
  /** 一句话说明（菜单/详情/文档共用） */
  desc: string;
}

const t = (name: string, description: string): ServerToolMeta => ({ name, description });

export const MCP_PRELOADS: PreloadDef[] = [
  {
    name: "memory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    desc: "跨会话知识图谱记忆（实体-关系-观察三元组）",
    manifest: [
      t("create_entities", "创建实体（含观察）"),
      t("create_relations", "在实体间创建关系"),
      t("add_observations", "向已有实体添加观察"),
      t("delete_entities", "删除实体及其关系"),
      t("delete_observations", "删除实体的观察"),
      t("delete_relations", "删除实体间关系"),
      t("read_graph", "读取整个知识图谱"),
      t("search_nodes", "按查询搜索节点"),
      t("read_nodes", "读取指定实体"),
    ],
  },
  {
    name: "context7",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    desc: "库文档检索（最新版官方文档片段）",
    manifest: [
      t("resolve-library-id", "把库名解析成 context7 库 ID"),
      t("get-library-docs", "取库的文档片段（可带主题过滤）"),
    ],
  },
  {
    name: "github",
    command: "npx",
    args: ["-y", "@github/github-mcp-server"],
    desc: "GitHub 仓库/issue/PR 操作（需要 GITHUB_TOKEN 环境变量——缺令牌时连接失败会带引导）",
    manifest: [
      t("get_me", "当前认证用户"),
      t("search_repositories", "搜索仓库"),
      t("create_repository", "创建仓库"),
      t("get_file_contents", "读文件/目录内容"),
      t("create_or_update_file", "创建或更新单文件（直接提交）"),
      t("push_files", "批量推送多文件"),
      t("create_branch", "创建分支"),
      t("list_commits", "列提交"),
      t("create_issue", "创建 issue"),
      t("get_issue", "读 issue"),
      t("list_issues", "列 issue"),
      t("update_issue", "更新 issue"),
      t("add_issue_comment", "issue 评论"),
      t("search_issues", "搜索 issue/PR"),
      t("create_pull_request", "创建 PR"),
      t("get_pull_request", "读 PR"),
      t("list_pull_requests", "列 PR"),
      t("update_pull_request", "更新 PR"),
      t("create_pull_request_review", "创建 PR 审查"),
      t("merge_pull_request", "合并 PR"),
      t("get_pull_request_files", "PR 变更文件"),
      t("get_pull_request_status", "PR 状态检查"),
    ],
  },
  {
    name: "everything",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    desc: "MCP 官方自检 server（echo/图片/进度/资源全特性——验证链路通不通）",
    manifest: [
      t("echo", "回显输入（附随机上下文）"),
      t("add", "两数相加"),
      t("sampleLLM", "借 server 侧 LLM 采样"),
      t("getTinyImage", "返回 1x1 测试图（Orosus 工具结果暂只支持文本——显示占位说明）"),
      t("printEnv", "打印 server 可见环境变量"),
      t("longRunningOperation", "长任务 + 进度通知（测超时顺延）"),
      t("sampledNotification", "周期通知"),
      t("annotatedTool", "带注释的工具（测 tool 注解）"),
    ],
  },
  {
    name: "puppeteer",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    desc: "浏览器自动化（导航/点击/抓取/执行 JS 返回文字；截图是图片——工具结果通道暂只支持文本，显示占位说明，属预期行为非 bug）",
    manifest: [
      t("puppeteer_navigate", "导航到 URL"),
      t("puppeteer_screenshot", "截图（图片通道暂缺——占位说明）"),
      t("puppeteer_click", "点击元素"),
      t("puppeteer_fill", "填充输入框"),
      t("puppeteer_select", "选择下拉项"),
      t("puppeteer_hover", "悬停元素"),
      t("puppeteer_evaluate", "执行 JS 并返回结果"),
      t("puppeteer_resize", "调整视口大小"),
    ],
  },
];

export const isPreloadName = (name: string): boolean => MCP_PRELOADS.some((p) => p.name === name);

/** 预装工具注册门（T20 实现拍板 + 2026-09-30 用户拍板默认翻开）：预装工具整体标 deferred——
 *  但 tool-search 关态（enabled = false 显式）时 deferred 标记不生效（SW-26 联动：照常全量进请求），
 *  ~50 个预装工具会灌爆每个请求的上下文。故关态时预装仍进管理面/菜单/启停（catalog 行在），
 *  只是不注册工具。tool-search 现默认启用（预装批承重墙——当年默认关的前提「无东西出厂带
 *  deferred 工具」已推翻），显式关仍是逃生口。激活序为字典序（mcp 先于 tool-search）——
 *  运行时探针不可行，配置层直读是唯一确定口径。 */
export function shouldRegisterPreloadTools(home: string): boolean {
  const sectionEnabled = (raw: string): boolean | undefined => {
    if (!raw.includes("[tool-search]")) return undefined;
    const body = raw.slice(raw.indexOf("[tool-search]") + "[tool-search]".length);
    const next = body.indexOf("\n[");
    const seg = next >= 0 ? body.slice(0, next) : body;
    const m = /^enabled\s*=\s*(true|false)/m.exec(seg);
    return m === null ? undefined : m[1] === "true";
  };
  for (const file of [join(home, "modules.d", "tool-search.toml"), join(home, "config.toml")]) {
    if (!existsSync(file)) continue;
    try {
      const v = sectionEnabled(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      if (v !== undefined) return v; // 先读 modules.d（m4-8 新家）再回落 config.toml——首个显式值生效
    } catch { /* 坏文件当未配置 */ }
  }
  return true; // 无显式配置 = tool-search 默认开（2026-09-30 拍板翻转）——预装开箱即用
}
