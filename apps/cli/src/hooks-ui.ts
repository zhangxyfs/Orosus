import type { Harness } from "@orosus/core";
import { atomicWriteTextSync } from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "smol-toml";
import { HOOK_EVENTS, defaultProjectConfigFile, defaultUserConfigFile, evaluateProjectTrust, projectBucketKey, projectHooksDigest, trustFilePath, type HookEvent } from "@orosus/hooks";
import type { FullApp } from "./tui/fullapp.ts";

/** /settings → 钩子（m5-hooks T10，用户拍板不设 /hooks 命令）：列表样式参照 ZCode settings 钩子面
 *  （HooksList.tsx:181-243 逐项映射到 TUI pickOverlay 惯例）——分节（用户级/项目级）、行=事件+状态
 *  标记+命令（pickOverlay 单行约束——ZCode 两行制折为单行三段，偏差在案）、行内不显 matcher/超时
 *  （藏详情）、详情窗全字段 + e 启停（写盘缓挂 /reload）+ t 信任审查（即时生效，T9 现算门）。 */
export type HooksUiDeps = {
  getH: () => Harness;
  commandUi: CommandUi;
  reloadModulesIdle: (app: FullApp | undefined, busyToast: string) => string;
};

export interface HookRow {
  origin: "user" | "project";
  event: HookEvent;
  matcher?: string;
  command: string;
  timeout?: number;
  disabled: boolean;
  file: string;          // 所属 TOML 文件（写盘落点）
  tableIdx: number;      // 第几个 [[hooks.<Event>]] 表（行级写定位）
  hookIdx: number;       // 表内第几个 [[hooks.<Event>.hooks]]（行级写定位）
}

/** 读一层 hooks.toml 的行（[hooks] 解包——与模块自读同源口径）。 */
const readRows = (file: string, origin: "user" | "project"): HookRow[] => {
  if (!existsSync(file)) return [];
  let doc: Record<string, unknown>;
  try {
    doc = parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return []; // 坏文件——面板零行（generic 层已 warning；详情面以「文件不可读」空态呈现）
  }
  const section = typeof doc["hooks"] === "object" && doc["hooks"] !== null ? doc["hooks"] as Record<string, unknown> : {};
  const out: HookRow[] = [];
  for (const event of HOOK_EVENTS) {
    const tables = section[event];
    if (!Array.isArray(tables)) continue;
    tables.forEach((t, tableIdx) => {
      const hooks = (t as { hooks?: unknown[] })?.hooks;
      if (!Array.isArray(hooks)) return;
      hooks.forEach((h, hookIdx) => {
        const rec = h as { command?: unknown; timeout?: unknown; disabled?: unknown; matcher?: never };
        if (typeof rec.command !== "string") return;
        out.push({
          origin, event,
          ...(typeof (t as { matcher?: unknown }).matcher === "string" ? { matcher: (t as { matcher: string }).matcher } : {}),
          command: rec.command,
          ...(typeof rec.timeout === "number" ? { timeout: rec.timeout } : {}),
          disabled: rec.disabled === true,
          file, tableIdx, hookIdx,
        });
      });
    });
  }
  return out;
};

export interface HooksFace {
  userFile: string;
  projectFile: string;
  rows: HookRow[];
  projectApplicable: boolean;
  projectTrusted: boolean;
  projectDigest?: string;
}

/** 面板数据面：两层行 + 项目层信任态现算（T9 同源 evaluateProjectTrust——面板与执行门同一判据）。
 *  文件路径可注入（测试密封）；缺省 = 模块同款缺省路径。 */
export const hooksFace = (cwd: string, opts?: { userFile?: string; projectFile?: string; trustFile?: string }): HooksFace => {
  const userFile = opts?.userFile ?? defaultUserConfigFile();
  const projectFile = opts?.projectFile ?? defaultProjectConfigFile(cwd);
  const trust = evaluateProjectTrust(projectFile, cwd, opts?.trustFile ?? trustFilePath());
  return {
    userFile, projectFile,
    rows: [...readRows(userFile, "user"), ...readRows(projectFile, "project")],
    projectApplicable: trust.applicable,
    projectTrusted: trust.trusted,
    ...(trust.digest !== undefined ? { projectDigest: trust.digest } : {}),
  };
};

const rowLabel = (w: number, r: HookRow): string => {
  const status = r.disabled ? "[已停用]" : "";
  const origin = r.origin === "user" ? "用户" : "项目";
  const head = `${status}${r.event} · ${origin}`;
  const cmd = r.command.length > w - head.length - 5 ? `${r.command.slice(0, Math.max(4, w - head.length - 8))}…` : r.command;
  return `${head.padEnd(Math.min(18, head.length + 2))}${cmd}`;
};

/** TOML 行级启停写：定位第 (tableIdx+1) 个 [[hooks.<Event>]] 内第 (hookIdx+1) 个 [[hooks.<Event>.hooks]]
 *  小节，置/删 disabled 键（保注释保键序——config-migrate 行级纪律同源；EOL 跟随文件现状）。 */
export function setHookDisabled(file: string, event: HookEvent, tableIdx: number, hookIdx: number, disabled: boolean): void {
  const raw = readFileSync(file, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const tableHead = `[[hooks.${event}]]`;
  const hookHead = `[[hooks.${event}.hooks]]`;
  let seenTables = -1;
  let seenHooks = -1;
  let targetStart = -1; // 目标 [[...hooks]] 头行号
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === tableHead) { seenTables++; seenHooks = -1; continue; }
    if (t === hookHead) {
      seenHooks++;
      if (seenTables === tableIdx && seenHooks === hookIdx) { targetStart = i; break; }
    }
  }
  if (targetStart < 0) throw new Error(`未定位到第 ${tableIdx + 1} 张 ${event} 表的第 ${hookIdx + 1} 个钩子（文件结构已变——重进面板刷新）`);
  // 目标小节体 = 头行后到下一个节头前
  let bodyEnd = targetStart + 1;
  while (bodyEnd < lines.length && !/^\s*\[/.test(lines[bodyEnd]!)) bodyEnd++;
  const body = lines.slice(targetStart + 1, bodyEnd);
  const keyLine = body.findIndex((l) => /^\s*disabled\s*=/.test(l));
  if (disabled) {
    const insert = `disabled = true`;
    if (keyLine >= 0) lines[targetStart + 1 + keyLine] = insert;
    else lines.splice(targetStart + 1, 0, insert);
  } else if (keyLine >= 0) {
    lines.splice(targetStart + 1 + keyLine, 1);
  }
  writeFileSyncSafe(file, `${lines.join(eol)}${raw.endsWith("\n") || raw.endsWith("\r\n") ? eol : ""}`);
}

/** 信任写盘（t 键）：读-改-写合并 + atomicWriteTextSync（CK-07 修复成果件复用——core index 转出）；
 *  坏文件先隔离留档再当空表重写（trust.ts:54-57 quarantine 先例同款）；目录惰性创建（首写 mkdir recursive）。 */
export function trustProjectHooks(cwd: string, trustFile = trustFilePath()): { digest: string } {
  const digest = projectHooksDigest(defaultProjectConfigFile(cwd));
  if (digest === undefined) throw new Error("项目层 hooks.toml 不存在或不可读——无从审查");
  let table: Record<string, unknown> = {};
  if (existsSync(trustFile)) {
    try {
      table = JSON.parse(readFileSync(trustFile, "utf8")) as Record<string, unknown>;
    } catch {
      try { renameSync(trustFile, `${trustFile}.corrupt-${Date.now()}`); } catch { /* best-effort 留档 */ }
      table = {};
    }
  }
  mkdirSync(dirname(trustFile), { recursive: true });
  table[projectBucketKey(cwd)] = { digest, trustedAt: new Date().toISOString() };
  atomicWriteTextSync(trustFile, JSON.stringify(table, null, 2), { mode: 0o600 });
  return { digest };
};

/** 写文件统一出口（行级写同款 EOL/BOM 纪律——剥头 BOM 后重写为无 BOM UTF-8）。 */
const writeFileSyncSafe = (file: string, content: string): void => {
  writeFileSync(file, content.replace(/^\uFEFF/, ""), "utf8");
};

const detailText = (w: number, r: HookRow, face: HooksFace): string => {
  const l: string[] = [];
  l.push(`事件：${r.event}`);
  l.push(`来源：${r.origin === "user" ? `用户级（${r.file}）` : `项目级（${r.file}）`}`);
  if (r.matcher !== undefined) l.push(`matcher：${r.matcher}`);
  l.push(`命令：${r.command}`);
  l.push(`超时：${r.timeout !== undefined && r.timeout > 0 ? `${r.timeout} 秒` : "全局默认（timeoutMs）"}`);
  l.push(`状态：${r.disabled ? "已停用" : "启用中"}`);
  if (r.origin === "project") {
    l.push(`信任：${!face.projectApplicable ? "不适用（无项目层）" : face.projectTrusted ? "已信任（digest 匹配）" : `待审（digest ${face.projectDigest?.slice(0, 12)}… 不匹配或未登记）`}`);
  }
  l.push("");
  l.push(r.origin === "project" && face.projectApplicable && !face.projectTrusted
    ? "e 启停（写盘缓挂 /reload） · t 信任审查（即时生效——按当前内容登记 sha256） · Esc 返回"
    : "e 启停（写盘缓挂 /reload） · Esc 返回");
  return l.map((x) => x.length > w ? `${x.slice(0, w - 1)}…` : x).join("\n");
};

const EMPTY_TEXT = (w: number): string => {
  const t = [
    "尚未配置钩子——新建钩子以在任务生命周期事件中运行命令。",
    "",
    "常见三场景：",
    "  · 完成/审批时桌面通知（Stop / PermissionRequest）",
    "  · 写后自动格式化（PostToolUse）",
    "  · 敏感命令拦截（PreToolUse）",
    "",
    "配置文件：~/.orosus/modules.d/hooks.toml（用户级）与 <项目>/.orosus/modules.d/hooks.toml（项目级，首次生效前需在此面板 t 键审查）。",
    "出厂注释示例随首次创建 modules.d 播种；完整协议参考见 docs/hooks.md。写好后 /reload 生效。",
  ];
  return t.map((x) => (x.length > w ? `${x.slice(0, w - 1)}…` : x)).join("\n");
};

export const openHooksPanel = async (app: FullApp, deps: HooksUiDeps): Promise<void> => {
  let selAt = 0;
  for (;;) {
    const face = hooksFace(process.cwd());
    if (face.rows.length === 0) {
      app.viewText("钩子", EMPTY_TEXT(app.pickRowWidth()), { layout: "dock" });
      return;
    }
    const w = app.pickRowWidth();
    const items: string[] = [];
    const idxOf: number[] = []; // items 下标 → rows 下标（节标题行跳过）
    const userRows = face.rows.filter((r) => r.origin === "user");
    const projRows = face.rows.filter((r) => r.origin === "project");
    if (userRows.length > 0) { items.push(`── 用户级（${face.userFile}）──`); idxOf.push(-1); }
    for (const r of userRows) { items.push(rowLabel(w, r)); idxOf.push(face.rows.indexOf(r)); }
    if (projRows.length > 0) {
      items.push(face.projectApplicable && !face.projectTrusted
        ? `── 项目级（${face.projectFile}）⚠ 钩子可在沙盒外运行，请审查最近安装或修改的所有钩子（t 审查后生效）──`
        : `── 项目级（${face.projectFile}）──`);
      idxOf.push(-1);
    }
    for (const r of projRows) { items.push(rowLabel(w, r)); idxOf.push(face.rows.indexOf(r)); }
    const picked = await app.pickOverlay("钩子（回车查看详情）", items, selAt);
    if (picked === undefined) return;
    if (idxOf[picked] === -1 || idxOf[picked] === undefined) continue; // 节标题行——重开列表
    selAt = picked;
    const row = face.rows[idxOf[picked]!]!;
    const detail = (): string => detailText(w, row, face);
    app.viewText("钩子详情", detail(), { layout: "dock", keys: {
      "e": {
        label: "e 启用或停用",
        run: (): string => {
          const next = !row.disabled;
          try {
            setHookDisabled(row.file, row.event, row.tableIdx, row.hookIdx, next);
          } catch (err) {
            app.showToast(err instanceof Error ? err.message : String(err));
            return detail();
          }
          row.disabled = next;
          const busyNote = deps.reloadModulesIdle(app, next ? `已停用，有任务在执行，稍后 /reload 生效` : `已启用，有任务在执行，稍后 /reload 生效`);
          app.showToast(busyNote === "" ? `${next ? "已停用" : "已启用"}（已重载生效）` : busyNote);
          return detail();
        },
      },
      ...(row.origin === "project" && face.projectApplicable && !face.projectTrusted ? {
        "t": {
          label: "t 信任审查（登记当前内容 sha256，即时生效）",
          run: (): string => {
            try {
              const { digest } = trustProjectHooks(process.cwd());
              face.projectTrusted = true;
              face.projectDigest = digest;
              app.showToast(`已信任项目层钩子（digest ${digest.slice(0, 12)}…——配置再改需重审）`);
            } catch (err) {
              app.showToast(err instanceof Error ? err.message : String(err));
            }
            return detail();
          },
        },
      } : {}),
    } });
  }
};

/** 行模式对等件：choose 列表 → 详情直出 → 动作菜单。 */
export const openHooksLine = async (out: (s: string) => void, deps: HooksUiDeps): Promise<void> => {
  for (;;) {
    const face = hooksFace(process.cwd());
    if (face.rows.length === 0) { out(EMPTY_TEXT(76)); return; }
    const items = face.rows.map((r) => rowLabel(76, r));
    const picked = await deps.commandUi.choose(`钩子（回车查看详情${face.projectApplicable && !face.projectTrusted ? "——项目层待审" : ""}）`, items);
    const i = items.indexOf(picked);
    if (i < 0) return;
    const row = face.rows[i]!;
    out(detailText(76, row, face));
    try {
      const actions = [row.disabled ? "启用" : "停用", ...(row.origin === "project" && face.projectApplicable && !face.projectTrusted ? ["信任审查（登记 sha256）"] : []), "返回列表"];
      const action = await deps.commandUi.choose(`${row.event} · ${row.origin === "user" ? "用户级" : "项目级"}`, actions);
      if (action === "启用" || action === "停用") {
        setHookDisabled(row.file, row.event, row.tableIdx, row.hookIdx, !row.disabled);
        const busyNote = deps.reloadModulesIdle(undefined, "有任务在执行，稍后 /reload 生效");
        out(busyNote === "" ? `已${!row.disabled ? "停用" : "启用"}（已重载生效）` : `已${!row.disabled ? "停用" : "启用"}——${busyNote}`);
      } else if (action === "信任审查（登记 sha256）") {
        const { digest } = trustProjectHooks(process.cwd());
        out(`已信任项目层钩子（digest ${digest.slice(0, 12)}…——配置再改需重审，即时生效）`);
      }
    } catch (err) {
      if (err instanceof Error && err.message === "已取消（Esc）") continue;
      throw err;
    }
  }
};
