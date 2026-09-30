import type { WidgetSpec } from "@orosus/contracts/module";
import { writeNestedTable, type NestedTableValue } from "@orosus/core";
import { splitCommandLine } from "./mcp-cmd.ts";
import type { FullApp, HostDialogKeys, DialogKeyCtx } from "./tui/fullapp.ts";
import type { McpCatalogRow } from "@orosus/mcp";

/** T17（m4-3c）：Alt + N 添加/修改窗——手动/JSON 两页签（Shift + ←→ 切换、共享草稿互转不丢）、
 *  传输方式三档（行内 ←→ 切换——走查拍板 2026-09-30）、高级区字段随档位联动、JSON 五种错误文案
 *  （原型屏 6 注记全稿）。形态 = 控件窗 dock（窗体与输入框同宽、贴输入框上缘——原型首版画窄被
 *  用户打回，实现引以为戒）。 */

export type TransportTier = "stdio" | "http" | "sse";

export const TRANSPORT_TIERS: readonly { id: TransportTier; label: string }[] = [
  { id: "stdio", label: "stdio 子进程" },
  { id: "http", label: "HTTP（远程）" },
  { id: "sse", label: "SSE" },
];

/** 手动页草稿（两页签共享体——切页签互转）。 */
export interface AddDraft {
  name: string;
  transport: TransportTier;
  /** stdio = 整行命令（保存时守卫拆分）；远程两档 = URL */
  cmd: string;
  /** 多行 KEY=VALUE 每行一条；edit 模式裸 KEY = 保持原值 */
  env: string;
  headers: string;
  cwd: string;
  /** 秒（空 = 缺省 60） */
  timeout: string;
  jsonText: string;
}

export const emptyDraft = (): AddDraft => ({ name: "", transport: "stdio", cmd: "", env: "", headers: "", cwd: "", timeout: "", jsonText: "" });

/** 手动草稿 → JSON 文本（页签互转——从手动切到 JSON 时预填）。 */
export function draftToJson(d: AddDraft): string {
  const body: Record<string, unknown> = d.transport === "stdio"
    ? { command: d.cmd.split(" ")[0] ?? "", ...(d.cmd.includes(" ") ? { args: d.cmd.split(" ").slice(1) } : {}) }
    : { url: d.cmd, ...(d.transport === "sse" ? { transport: "sse" } : {}) };
  const env = parseKeyValueLines(d.env, "add").pairs;
  if (Object.keys(env).length > 0) body.env = env;
  if (d.transport === "stdio" && d.cwd !== "") body.cwd = d.cwd;
  if (d.timeout !== "") body.timeoutMs = Number(d.timeout) * 1000;
  return JSON.stringify({ mcpServers: { [d.name === "" ? "名字" : d.name]: body } }, null, 2);
}

/** JSON 文本 → 手动草稿（互转；解析失败返回原草稿——JSON 页修好再切）。 */
export function jsonToDraft(text: string, d: AddDraft): AddDraft {
  const parsed = parseJsonPaste(text);
  if (parsed.error !== undefined || parsed.name === undefined || parsed.values === undefined) return d;
  const next = { ...d, name: parsed.name, jsonText: text };
  const v = parsed.values;
  if (typeof v.url === "string") {
    next.cmd = v.url;
    next.transport = v.transport === "sse" ? "sse" : "http";
  } else {
    next.transport = "stdio";
    next.cmd = [v.command ?? "", ...(Array.isArray(v.args) ? v.args : [])].join(" ").trim();
  }
  next.env = Object.entries(v.env ?? {}).map(([k, val]) => `${k}=${val}`).join("\n");
  next.headers = Object.entries(v.headers ?? {}).map(([k, val]) => `${k}=${val}`).join("\n");
  if (typeof v.cwd === "string") next.cwd = v.cwd;
  if (typeof v.timeoutMs === "number") next.timeout = String(Math.round(v.timeoutMs / 1000));
  return next;
}

/** env/headers 多行解析：`KEY=VALUE` 每行一条；mode=edit 时裸 KEY（无 =）= 保持原值不覆盖。
 *  坏行（KEY=VALUE 之外的非空行且非裸 KEY）报错。 */
export function parseKeyValueLines(text: string, mode: "add" | "edit"): { pairs: Record<string, string>; keepOnly: string[]; error?: string } {
  const pairs: Record<string, string> = {};
  const keepOnly: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1);
      if (k === "") return { pairs, keepOnly, error: "环境变量/请求头里有空键名的行——检查 KEY=VALUE 格式" };
      pairs[k] = v.trim(); // 值两侧空白视为排版（KEY=VALUE 手敲形态）
    } else if (mode === "edit" && /^[A-Za-z0-9_.-]+$/.test(line)) {
      keepOnly.push(line); // 只显键名的行 = 留空保持原值
    } else {
      return { pairs, keepOnly, error: `「${line}」不是 KEY=VALUE 形态${mode === "edit" ? "（修改时也可只写键名=保持原值）" : ""}` };
    }
  }
  return { pairs, keepOnly };
}

/** 手动草稿 → 配置表值（校验全链：名称/重名/命令守卫/URL/超时数值）。 */
export function buildManualValues(d: AddDraft, opts: {
  mode: "add" | "edit";
  originalName?: string;
  existingNames: string[];
}): { name?: string; values?: Record<string, NestedTableValue>; error?: string } {
  const name = d.name.trim();
  if (name === "") return { error: "名称是必填的——列表和权限规则都靠名字认 server" };
  if (opts.mode === "add" && opts.existingNames.includes(name)) {
    return { error: `已存在同名 server「${name}」——不覆盖别人的配置；想改它请用修改` };
  }
  if (d.transport === "stdio") {
    if (d.cmd.trim() === "") return { error: "命令是必填的——整行收（如 npx -y my-search-mcp --port 9），保存时统一拆分" };
    const split = splitCommandLine(d.cmd.trim());
    if (!split.ok) return { error: split.error };
    const envParsed = parseKeyValueLines(d.env, opts.mode);
    if (envParsed.error !== undefined) return { error: envParsed.error };
    const values: Record<string, NestedTableValue> = { command: split.command, ...(split.args.length > 0 ? { args: split.args } : {}) };
    if (Object.keys(envParsed.pairs).length > 0) values.env = envParsed.pairs;
    if (d.cwd.trim() !== "") values.cwd = d.cwd.trim();
    if (d.timeout.trim() !== "") {
      const sec = Number(d.timeout);
      if (!Number.isFinite(sec) || sec <= 0) return { error: "超时得是正数秒——留空用默认 60 秒" };
      values.timeoutMs = Math.round(sec * 1000);
    }
    return { name, values };
  }
  // 远程两档
  if (d.cmd.trim() === "" || !/^https?:\/\//i.test(d.cmd.trim())) return { error: "URL 得以 http:// 或 https:// 开头" };
  const headersParsed = parseKeyValueLines(d.headers, opts.mode);
  if (headersParsed.error !== undefined) return { error: headersParsed.error };
  const envParsed = parseKeyValueLines(d.env, opts.mode);
  if (envParsed.error !== undefined) return { error: envParsed.error };
  const values: Record<string, NestedTableValue> = { url: d.cmd.trim() };
  if (d.transport === "sse") values.transport = "sse";
  if (Object.keys(headersParsed.pairs).length > 0) values.headers = headersParsed.pairs;
  if (Object.keys(envParsed.pairs).length > 0) values.env = envParsed.pairs;
  if (d.timeout.trim() !== "") {
    const sec = Number(d.timeout);
    if (!Number.isFinite(sec) || sec <= 0) return { error: "超时得是正数秒——留空用默认 60 秒" };
    values.timeoutMs = Math.round(sec * 1000);
  }
  return { name, values };
}

/** JSON 粘贴解析：吃单 server 对象与 Claude 包裹；五种错误文案 = 原型屏 6 注记全稿（逐条照抄）。 */
export function parseJsonPaste(text: string): { name?: string; values?: Record<string, NestedTableValue>; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "这不是合法的 JSON——检查引号、逗号是否配对完整" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "这不是合法的 JSON——检查引号、逗号是否配对完整" };
  }
  let obj = parsed as Record<string, unknown>;
  if (obj["mcpServers"] !== undefined) {
    const inner = obj["mcpServers"];
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      return { error: "mcpServers 里面是空的——没有可安装的 server" };
    }
    obj = inner as Record<string, unknown>;
  }
  const names = Object.keys(obj).filter((k) => obj[k] !== null && typeof obj[k] === "object");
  if (names.length === 0) return { error: "mcpServers 里面是空的——没有可安装的 server" };
  if (names.length > 1) {
    return { error: `一次只能装一个 server——这段里有 ${names.length} 个（${names.slice(0, 3).join("、")}），删到剩一个再保存` };
  }
  const name = names[0]!;
  const entry = obj[name] as Record<string, unknown>;
  const hasCommand = typeof entry["command"] === "string" && entry["command"] !== "";
  const hasUrl = typeof entry["url"] === "string" && entry["url"] !== "";
  if (!hasCommand && !hasUrl) {
    return { error: "server 条目缺启动方式——command（本地命令）或 url（远程地址）至少要有一个" };
  }
  const values: Record<string, NestedTableValue> = {};
  if (hasUrl) values.url = entry["url"] as string;
  else {
    values.command = entry["command"] as string;
    if (Array.isArray(entry["args"]) && (entry["args"] as unknown[]).every((a) => typeof a === "string")) {
      values.args = entry["args"] as string[];
    }
  }
  if (entry["transport"] === "sse") values.transport = "sse";
  for (const [src, dst] of [["env", "env"], ["headers", "headers"]] as const) {
    const v = entry[src];
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    const pairs: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") pairs[k] = val;
    }
    if (Object.keys(pairs).length > 0) values[dst] = pairs;
  }
  if (typeof entry["cwd"] === "string") values.cwd = entry["cwd"];
  if (typeof entry["timeoutMs"] === "number" && entry["timeoutMs"] > 0) values.timeoutMs = entry["timeoutMs"];
  return { name, values };
}

/** 页签/高级区/错误行渲染（widget 清单构造——导出供结构测试）。 */
export function buildAddWidgets(st: {
  tab: "manual" | "json";
  mode: "add" | "edit";
  transport: TransportTier;
  advOpen: boolean;
  err: string;
  ok: string;
  editName?: string | undefined;
}): WidgetSpec[] {
  const remote = st.transport !== "stdio";
  const tabLine = `  ${st.tab === "manual" ? "▶ 手动" : "  手动"}  │  ${st.tab === "json" ? "▶ JSON" : "  JSON"}    （Shift + ←→ 切换方式——两种方式共享同一份草稿，切过去内容互转不丢）`;
  const widgets: WidgetSpec[] = [{ id: "tabs", kind: "text", text: tabLine, style: "accent" }];
  if (st.tab === "manual") {
    widgets.push(
      st.mode === "edit"
        ? { id: "name-lock", kind: "kv", label: "名称", value: `${st.editName ?? ""}（名称不可改——删除后重加）` }
        : { id: "name", kind: "input", placeholder: "my-search——列表和权限规则都靠名字认 server" },
      { id: "transport", kind: "list", interactive: true, items: TRANSPORT_TIERS.map((t) => `${t.id === st.transport ? "●" : "○"} ${t.label}`) },
      { id: "cmd", kind: "input", placeholder: remote ? "https://mcp.internal.example.com/sse" : "npx -y my-search-mcp --port 9（整行收——保存时统一拆）" },
      { id: "adv", kind: "list", interactive: true, items: [`${st.advOpen ? "▾" : "▸"} 高级选项${st.advOpen ? "" : remote ? "（环境变量 / 请求头 / 超时）" : "（环境变量 / 工作目录 / 超时）"}`] },
    );
    if (st.advOpen) {
      widgets.push({ id: "env", kind: "input", multiline: true, lines: 2, placeholder: st.mode === "edit" ? "GITHUB_TOKEN（只写键名=保持原值）" : "GITHUB_TOKEN=… 每行一条" });
      if (remote) widgets.push({ id: "headers", kind: "input", multiline: true, lines: 2, placeholder: "Authorization=Bearer … 每行一条" });
      else widgets.push({ id: "cwd", kind: "input", placeholder: "子进程工作目录（仅本地命令）" });
      widgets.push({ id: "timeout", kind: "input", placeholder: "调用超时（秒，留空 = 60）" });
    }
  } else {
    widgets.push(
      { id: "json-hint", kind: "text", text: "粘贴一段配置——两种格式都吃：{\"名字\": {\"command\": …}} 单 server，或 Claude 包裹 {\"mcpServers\": {…}}。一次只装一个。", style: "muted" },
      { id: "json", kind: "input", multiline: true, lines: 7, placeholder: "{\"mcpServers\": {\"my-search\": {\"command\": \"npx\", \"args\": [\"-y\", \"my-search-mcp\"]}}}" },
    );
  }
  if (st.err !== "") widgets.push({ id: "msg", kind: "text", text: `✕ ${st.err}`, style: "warn" });
  else if (st.ok !== "") widgets.push({ id: "msg", kind: "text", text: `✓ ${st.ok}`, style: "accent" });
  return widgets;
}

/** 开窗（fullapp 驱动）。onSaved 在写盘成功后回调（重载与列表刷新归调用方）。 */
export function openMcpAddWindow(app: FullApp, opts: {
  mode: "add" | "edit";
  row?: McpCatalogRow;
  original?: Record<string, unknown>;
  configPath: string;
  existingNames: string[];
  onSaved: (name: string) => void;
}): void {
  const orig = opts.original ?? {};
  const readStr = (k: string): string => (typeof orig[k] === "string" ? orig[k] as string : "");
  const readMap = (k: string): string => {
    const v = orig[k];
    if (v === null || typeof v !== "object" || Array.isArray(v)) return "";
    return Object.keys(v as Record<string, unknown>).join("\n"); // edit：只显键名不显值（拍板）
  };
  const initialTransport: TransportTier = opts.row?.transport === "http" ? (readStr("transport") === "sse" ? "sse" : "http") : "stdio";
  const st = {
    tab: "manual" as "manual" | "json",
    mode: opts.mode,
    transport: initialTransport,
    advOpen: opts.mode === "edit",
    err: "",
    ok: "",
    editName: opts.row?.name,
  };
  const draft: AddDraft = opts.mode === "edit"
    ? {
        name: opts.row?.name ?? "",
        transport: initialTransport,
        cmd: opts.row?.transport === "http" ? readStr("url") : (opts.row?.command ?? ""),
        env: readMap("env"),
        headers: readMap("headers"),
        cwd: readStr("cwd"),
        timeout: typeof orig["timeoutMs"] === "number" ? String(Math.round((orig["timeoutMs"] as number) / 1000)) : "",
        jsonText: "",
      }
    : emptyDraft();

  let handle: ReturnType<FullApp["openDialogHost"]> | undefined;
  const save = (): void => {
    const built = st.tab === "manual"
      ? buildManualValues(draft, { mode: st.mode, existingNames: opts.existingNames.filter((n) => n !== st.editName) })
      : (() => {
          const parsed = parseJsonPaste(draft.jsonText);
          if (parsed.error !== undefined) return { error: parsed.error };
          if (parsed.name !== undefined && st.mode === "add" && opts.existingNames.includes(parsed.name)) {
            return { error: `已存在同名 server「${parsed.name}」——不覆盖别人的配置；想改它请用修改` };
          }
          return parsed;
        })();
    if (built.error !== undefined || built.name === undefined || built.values === undefined) {
      st.ok = "";
      st.err = built.error ?? "保存失败";
      handle?.update(buildAddWidgets(st));
      return;
    }
    const targetName = st.mode === "edit" ? (st.editName ?? built.name) : built.name;
    writeNestedTable(opts.configPath, `mcp.servers.${targetName}`, built.values);
    st.err = "";
    st.ok = "已保存——Esc 关窗，回列表看红绿灯（模块图随后重载）";
    handle?.update(buildAddWidgets(st));
    opts.onSaved(targetName);
  };

  const spec = (): { title: string; widgets: WidgetSpec[]; layout: "dock"; hostKeys: HostDialogKeys; onEvent: (e: { type: string; id: string; text?: string; index?: number }) => WidgetSpec[] | void } => ({
    title: st.mode === "edit" ? `修改 MCP server · ${st.editName ?? ""}` : "添加 MCP server",
    widgets: buildAddWidgets(st),
    layout: "dock",
    hostKeys: {
      "shift+left": { label: "Shift + ←→ 切页签", run: (): boolean => {
        if (st.tab === "manual") { draft.jsonText = draftToJson(draft); st.tab = "json"; } else { Object.assign(draft, jsonToDraft(draft.jsonText, draft)); st.tab = "manual"; }
        st.err = "";
        st.ok = "";
        handle?.update(buildAddWidgets(st));
        return true;
      } },
      "shift+right": { label: "", run: (): boolean => {
        if (st.tab === "manual") { draft.jsonText = draftToJson(draft); st.tab = "json"; } else { Object.assign(draft, jsonToDraft(draft.jsonText, draft)); st.tab = "manual"; }
        st.err = "";
        st.ok = "";
        handle?.update(buildAddWidgets(st));
        return true;
      } },
      "shift+up": { label: "Shift + ↑↓ 换焦点", run: (ctx: DialogKeyCtx): boolean => { ctx.moveFocus(-1); return true; } },
      "shift+down": { label: "", run: (ctx: DialogKeyCtx): boolean => { ctx.moveFocus(1); return true; } },
      left: { label: "", run: (ctx: DialogKeyCtx): boolean => {
        if (ctx.focusedId !== "transport") return false; // 不消费——回落输入框光标
        const i = TRANSPORT_TIERS.findIndex((t) => t.id === st.transport);
        st.transport = TRANSPORT_TIERS[(i - 1 + TRANSPORT_TIERS.length) % TRANSPORT_TIERS.length]!.id;
        draft.transport = st.transport;
        ctx.setSel("transport", TRANSPORT_TIERS.findIndex((t) => t.id === st.transport));
        handle?.update(buildAddWidgets(st));
        return true;
      } },
      right: { label: "", run: (ctx: DialogKeyCtx): boolean => {
        if (ctx.focusedId !== "transport") return false;
        const i = TRANSPORT_TIERS.findIndex((t) => t.id === st.transport);
        st.transport = TRANSPORT_TIERS[(i + 1) % TRANSPORT_TIERS.length]!.id;
        draft.transport = st.transport;
        ctx.setSel("transport", TRANSPORT_TIERS.findIndex((t) => t.id === st.transport));
        handle?.update(buildAddWidgets(st));
        return true;
      } },
    },
    onEvent: (e): WidgetSpec[] | void => {
      if (e.type === "input") {
        const text = e.text ?? "";
        if (e.id === "name") draft.name = text;
        else if (e.id === "cmd") draft.cmd = text;
        else if (e.id === "env") draft.env = text;
        else if (e.id === "headers") draft.headers = text;
        else if (e.id === "cwd") draft.cwd = text;
        else if (e.id === "timeout") draft.timeout = text;
        else if (e.id === "json") draft.jsonText = text;
        return; // 输入不打扰其余区（错误行保留到下一次保存尝试）
      }
      if (e.type === "select" && e.id === "transport") {
        const idx = e.index ?? 0;
        const tier = TRANSPORT_TIERS[Math.max(0, Math.min(TRANSPORT_TIERS.length - 1, idx))];
        if (tier !== undefined) { st.transport = tier.id; draft.transport = tier.id; handle?.update(buildAddWidgets(st)); }
        return;
      }
      if (e.type === "activate") {
        if (e.id === "adv") { st.advOpen = !st.advOpen; handle?.update(buildAddWidgets(st)); return; }
        if (e.id === "transport") return; // 传输行 Enter 不做事（←→ 或 ↑↓ 切）
        save(); // 其余输入框 Enter = 保存（原型「Enter 激活」）
      }
    },
  });
  const s = spec();
  handle = app.openDialogHost(s);
}
