/** dialog 控件窗中继（web-dialog 批 T3，设计 §5.1/§6/§7）。
 *  每会话一个（WebCommandUi 组合）：管「当前唯一活跃窗」的全生命周期——往 SSE 发 open/update/close 帧、
 *  接浏览器事件调模块 onEvent、每秒动态值刷新 + owner 活性巡检。
 *
 *  与既有桥接两形态的关系：interaction 是「广播即完成」（notice/viewText）或「等浏览器应答」（askable
 *  挂起），dialog 是第三种——跨时刻持久状态（开窗 → 若干次更新 → 关窗）。Web 单活替换（新窗/新
 *  viewText/新问询先关旧窗），不搬 TUI 的 FIFO 排队。
 *
 *  语义锚点（自仓 TUI）：句柄失效 = fullapp-dialogs.ts 排队期无操作同款（闭包持 record 引用比对）；
 *  onEvent 返回清单 = 整窗替换滚回顶（reset:"all"）；update 滚回顶保留焦点（reset:"selection"）；
 *  卸载巡检 notice 用 TUI closeModuleUi 同款文案。 */
import type { DialogEvent, DialogHandle, DialogSpec, PopupLayout, WidgetSpec } from "@orosus/contracts/module";

/** 序列化后的控件（SSE 不能传函数——设计 §7）：函数字段求值成 JSON 值，其余原样浅拷贝。 */
export type SerializedWidget =
  | { id: string; kind: "text"; text: string; style?: "muted" | "accent" | "warn"; wrap?: "auto" | "none" }
  | { id: string; kind: "kv"; label: string; value: string }
  | { id: string; kind: "sep" }
  | { id: string; kind: "list"; interactive?: boolean; items: string[] }
  | { id: string; kind: "progress"; value: number; max: number }
  | { id: string; kind: "input"; label?: string; multiline?: boolean; lines?: number; enterSubmit?: boolean; placeholder?: string }
  | { id: string; kind: "columns"; cols: SerializedWidget[][]; widths?: number[] }
  | { id: string; kind: "table"; head: string[]; rows: string[][] };

/** dialog 三态帧（设计 §6.1-§6.3）。id 与既有 interaction 共用会话内单调序号（经 deps.nextId）。 */
export type DialogFrame =
  | { id: string; kind: "dialog"; op: "open"; revision: number; title: string; layout?: PopupLayout; widgets: SerializedWidget[] }
  | { id: string; kind: "dialog"; op: "update"; revision: number; reset: "selection" | "all" | "none"; widgets: SerializedWidget[] }
  | { id: string; kind: "dialog"; op: "close" };

export interface DialogRelayDeps {
  broadcast(frame: DialogFrame): void;   // 接 WebCommandUi.deps.broadcast 同一出口（sse.ts 按会话扇出全部标签）
  notice(text: string): void;            // 模块回调抛错/卸载关窗的带内反馈（设计 §6.4）
  isOwnerActive(owner: string): boolean; // hs.core.graph().audit() 活跃集判定（owner 巡检 + 迟到事件安全网）
  nextId(): string;                      // 桥的 w<seq> 会话内单调序号——与 askable/viewText 共用防撞 id
}

/** relay 返回的句柄：契约面 update/close 之外多一个 idOf()（测试与端点接线缝——经 DialogHandle 类型
 *  透传给模块时不可见，不进契约）。 */
export type RelayDialogHandle = DialogHandle & { idOf(): string };

const PLACEHOLDER_TEXT = "（动态值暂不可用）"; // 空白登记 #3：设计 §7 只说「警告占位」，文案本批定

interface ActiveRecord {
  id: string;
  spec: DialogSpec;
  widgets: WidgetSpec[];        // 当前控件源（open = spec.widgets；update/onEvent 整份替换）
  revision: number;
  lastJson: string;             // 上次序列化结果——timer 只在 JSON 变化时广播
  lastWidgets?: SerializedWidget[]; // 上一版序列化值——动态值求值异常时按字段回落（空白登记 #3）
}

const evalText = (fn: () => string, prev: unknown): string => {
  try { return fn(); } catch { return typeof prev === "string" ? prev : PLACEHOLDER_TEXT; }
};
const evalNum = (fn: () => number, prev: unknown): number => {
  try { return fn(); } catch { return typeof prev === "number" ? prev : 0; }
};

/** 上一版序列化值按 id 建索引（含 columns 嵌套）——求值异常的回落查表。 */
const prevIndex = (widgets: SerializedWidget[] | undefined, into: Map<string, SerializedWidget>): Map<string, SerializedWidget> => {
  for (const w of widgets ?? []) {
    into.set(w.id, w);
    if (w.kind === "columns") for (const col of w.cols) prevIndex(col, into);
  }
  return into;
};

const serializeWidget = (w: WidgetSpec, prev: Map<string, SerializedWidget>): SerializedWidget => {
  const p = prev.get(w.id);
  switch (w.kind) {
    case "text":
      return { id: w.id, kind: "text", text: typeof w.text === "function" ? evalText(w.text, p?.kind === "text" ? p.text : undefined) : w.text, ...(w.style !== undefined ? { style: w.style } : {}), ...(w.wrap !== undefined ? { wrap: w.wrap } : {}) };
    case "kv":
      return { id: w.id, kind: "kv", label: w.label, value: typeof w.value === "function" ? evalText(w.value, p?.kind === "kv" ? p.value : undefined) : w.value };
    case "progress":
      return { id: w.id, kind: "progress", value: typeof w.value === "function" ? evalNum(w.value, p?.kind === "progress" ? p.value : undefined) : w.value, max: w.max };
    case "columns":
      return { id: w.id, kind: "columns", cols: w.cols.map((col) => col.map((cw) => serializeWidget(cw, prev))), ...(w.widths !== undefined ? { widths: w.widths } : {}) };
    default:
      return { ...(w as Exclude<WidgetSpec, { kind: "text" | "kv" | "progress" | "columns" }>) }; // sep/list/input/table 无函数字段：原样浅拷贝
  }
};

const serializeWidgets = (widgets: WidgetSpec[], prev: SerializedWidget[] | undefined): SerializedWidget[] =>
  widgets.map((w) => serializeWidget(w, prevIndex(prev, new Map())));

/** 按控件 id 深找目标（含 columns 嵌套）——浏览器事件的目标控件须仍在当前清单里。 */
const findWidget = (widgets: WidgetSpec[], id: string): WidgetSpec | undefined => {
  for (const w of widgets) {
    if (w.id === id) return w;
    if (w.kind === "columns") for (const col of w.cols) { const hit = findWidget(col, id); if (hit !== undefined) return hit; }
  }
  return undefined;
};

/** 事件语义校验（设计 §6.4——浏览器不可信，服务端把关；结构校验在端点，这里的判定要读当前快照）：
 *  input → input 控件且 text 为串；select → interactive list 且整数索引落界；activate 带索引 →
 *  interactive list 同款、不带索引 → input（契约 DialogEvent：input 回车激活不带 index）。 */
const validateEvent = (widgets: WidgetSpec[], e: DialogEvent): boolean => {
  const w = findWidget(widgets, e.id);
  if (w === undefined) return false;
  if (e.type === "input") return w.kind === "input" && typeof e.text === "string";
  if (e.type === "select") {
    return w.kind === "list" && w.interactive === true && Number.isInteger(e.index) && e.index >= 0 && e.index < w.items.length;
  }
  if (e.index !== undefined) {
    return w.kind === "list" && w.interactive === true && Number.isInteger(e.index) && e.index >= 0 && e.index < w.items.length;
  }
  return w.kind === "input";
};

export class DialogRelay {
  private record: ActiveRecord | undefined;
  private timer: ReturnType<typeof setInterval> | undefined; // 空白登记 #4：1s 动态刷新 + owner 巡检共用，仅活跃窗存在时启动
  private readonly deps: DialogRelayDeps;

  constructor(deps: DialogRelayDeps) { this.deps = deps; }

  /** 开窗（单活替换：先广播旧 close 再 open）。返回句柄闭包持本 record——被替换后 update/close 静默无操作。 */
  open(spec: DialogSpec): RelayDialogHandle {
    this.closeActive();
    const id = this.deps.nextId();
    const widgets = serializeWidgets(spec.widgets, undefined);
    const r: ActiveRecord = { id, spec, widgets: spec.widgets, revision: 1, lastWidgets: widgets, lastJson: JSON.stringify(widgets) };
    this.record = r;
    this.deps.broadcast({ id, kind: "dialog", op: "open", revision: 1, title: spec.title, ...(spec.layout !== undefined ? { layout: spec.layout } : {}), widgets });
    this.ensureTimer();
    return {
      update: (ws: WidgetSpec[]) => { if (this.record === r) this.applyWidgets(r, ws, "selection"); }, // 内容相同也发：滚回顶是契约行为
      close: () => { if (this.record === r) this.closeActive(); },
      idOf: () => id,
    };
  }

  /** 新 viewText/可答 interaction 前关当前窗（设计 §5.1；notice 不动 dialog）。 */
  supersede(): void { this.closeActive(); }

  /** 广播更新并前移快照（reset 档：selection = 句柄 update 滚回顶保留输入；all = onEvent 整窗重置）。 */
  private applyWidgets(r: ActiveRecord, ws: WidgetSpec[], reset: "selection" | "all"): void {
    const widgets = serializeWidgets(ws, r.lastWidgets);
    r.widgets = ws;
    r.lastWidgets = widgets;
    r.lastJson = JSON.stringify(widgets);
    r.revision += 1;
    this.deps.broadcast({ id: r.id, kind: "dialog", op: "update", revision: r.revision, reset, widgets });
  }

  /** 浏览器事件（端点做完 HTTP/结构翻译后调这里；语义校验在本件——快照只在 relay 手里）。 */
  event(id: string, e: DialogEvent): { ok: true; revision?: number; closed?: boolean } | { ok: true; noop: true } {
    const r = this.record;
    if (r === undefined || r.id !== id) return { ok: true, noop: true };
    if (r.spec.owner !== undefined && !this.deps.isOwnerActive(r.spec.owner)) { // 迟到事件不复活已卸载模块的窗（设计 §10 安全网）
      this.closeActive();
      return { ok: true, noop: true };
    }
    if (!validateEvent(r.widgets, e)) return { ok: true, noop: true };
    if (r.spec.onEvent === undefined) return { ok: true, revision: r.revision };
    let next: WidgetSpec[] | void;
    try {
      next = r.spec.onEvent(e);
    } catch {
      this.deps.notice("控件窗事件处理出错"); // 窗保留在最后可用状态（设计 §6.4）
      return { ok: true };
    }
    if (this.record !== r) return { ok: true, closed: true }; // 回调内 close/被替换：record 重确认，过期 update 丢弃
    if (Array.isArray(next)) {
      this.applyWidgets(r, next, "all");
      return { ok: true, revision: r.revision };
    }
    return { ok: true, revision: r.revision };
  }

  /** 服务端关窗路径（handle.close/用户 close/替换/会话销毁/owner 卸载共用——设计 §6.3）。 */
  closeActive(): void {
    const r = this.record;
    if (r === undefined) return;
    this.record = undefined;
    this.clearTimer();
    this.deps.broadcast({ id: r.id, kind: "dialog", op: "close" });
  }

  /** 用户关窗（端点 close:true）：id 匹配当前 record 才关，未知/已关 id 幂等不动（设计 §6.4）。 */
  closeById(id: string): boolean {
    if (this.record?.id !== id) return false;
    this.closeActive();
    return true;
  }

  /** owner 匹配当前 record 才关（模块启停端点 diff 出消失模块后逐个调）。 */
  closeByOwner(owner: string): void {
    if (this.record?.spec.owner === owner) this.closeActive();
  }

  /** 重连重放用：活跃才存在，带最新 revision 与现值动态字段（设计 §6.1）。 */
  snapshotFrame(): DialogFrame | undefined {
    const r = this.record;
    if (r === undefined) return undefined;
    return { id: r.id, kind: "dialog", op: "open", revision: r.revision, title: r.spec.title, ...(r.spec.layout !== undefined ? { layout: r.spec.layout } : {}), widgets: serializeWidgets(r.widgets, r.lastWidgets) };
  }

  private tick(): void {
    const r = this.record;
    if (r === undefined) { this.clearTimer(); return; }
    if (r.spec.owner !== undefined && !this.deps.isOwnerActive(r.spec.owner)) {
      this.closeActive(); // /reload 命令路径的兜底关窗（≤1s，空白登记 #7）
      this.deps.notice(`模块 ${r.spec.owner} 已卸载——其窗口已关闭`); // TUI closeModuleUi 同款文案（fullapp-dialogs.ts:190）
      return;
    }
    const widgets = serializeWidgets(r.widgets, r.lastWidgets);
    const json = JSON.stringify(widgets);
    if (json !== r.lastJson) {
      r.lastWidgets = widgets;
      r.lastJson = json;
      r.revision += 1;
      this.deps.broadcast({ id: r.id, kind: "dialog", op: "update", revision: r.revision, reset: "none", widgets });
    }
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.(); // 假计时器无 unref 面；真定时器不挡进程退出
  }

  private clearTimer(): void {
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
  }
}
