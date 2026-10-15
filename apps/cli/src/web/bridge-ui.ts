/** WebCommandUi —— web 批 T5 交互桥：core 模块的 ctx.ui 调用（ask/askSecret/choose/confirm/
 *  chooseEx/chooseSide/viewText/notice/dialog）桥接为 SSE interaction 帧（§3），浏览器经
 *  POST /answer（可答族）与 POST /dialog-event（控件窗，web-dialog 批 T5）应答回传——审批/
 *  问询/控件窗全量浏览器化的心脏。
 *  - 挂起模型：每次可答交互登记 pending Map<id,{resolve,reject,frame}> + 广播帧；**settle 纪律 =
 *    先删 Map 项再 settle**（防重入双投递——ZCode interaction-registry 同纪律）。无超时（§4-16：与
 *    TUI 一致——审批可以一直等；ZCode 的 60s/300s 状态机在档备将来）。
 *  - 幂等：已 settle / 未知 id 的 answer|cancel → noop（多端抢答先到先得——qwen/dsh 先例；「不做
 *    per-client 绑定」是多标签抢答是特性，§4-16）。
 *  - 取消语义：reject「已取消（Esc）」（ESC_CANCELLED 协议串——TUI Esc 同字面量，waterfall 抛错
 *    即否决）；confirm 按契约折 false（Esc 折为 false——语义内 fail-closed 不抛错，menu.ts 同款）。
 *  - 单向帧：viewText/notice 广播即完成（不进 pending、不设等相位）。
 *  - 等相位：挂起→presence.setWaiting("approval"|"input")、清空→null（presence.ts:119 同语义——
 *    approval pick→approval、ask 自由文本→input）；pending 清空才清位（多挂起并存时后挂者优先）。
 *  - 可选口（§4-17）：insertText/attachImage 仍不实现（模块自降级）；**dialog 已实现**（web-dialog
 *    批 T4——设计 specs/2026-10-14-web-dialog-design.md §5-§7：经 DialogRelay 单活管理，viewText/
 *    可答交互发出前 supersede 关当前窗）。
 *  - 帧形状（§3 + T5 定档扩展，T16 前端消费面）：
 *    {id, kind, title, items?, values?, text?, secret?, multi?, sideLabel?, markdown?, durationMs?}；
 *    dialog 帧（web-dialog 批）追加 op("open"|"update"|"close")/revision/reset/layout/widgets。 */
import type { CommandUi, DialogHandle, DialogSpec, PopupLayout } from "@orosus/contracts/module";
import type { Harness } from "@orosus/core";
import { ESC_CANCELLED } from "../i18n/protocol-strings.ts";
import { t } from "../i18n/app.ts";
import { sendInteractionFrame, setPendingInteractionSource, clearPendingInteractionSource, type InteractionPayload } from "./sse.ts";
import type { HostedSession } from "./hosted.ts";
import { DialogRelay, type DialogFrame, type SerializedWidget } from "./dialog-relay.ts";

/** interaction 帧类型（§3 kind 全八值 + dialog；sse.ts InteractionPayload 的本桥精化形——type alias
 *  以保 Record 透传兼容）。扩展键（T5 定档，供 T16 前端渲染）：multi（chooseEx 勾选/单选形态）、
 *  sideLabel（chooseSide 横选行标签）、markdown（viewText 正文渲染口径）、durationMs（notice 停留，
 *  契约 [1000,30000] 钳位后值）。dialog 帧五键（web-dialog 批 T4，设计 §6）：op / revision / reset /
 *  layout（dialog 与 viewText 共用——§9 布局保留）/ widgets（SerializedWidget[]，函数已求值）。 */
export type InteractionFrame = {
  id: string;
  kind: "choose" | "ask" | "askSecret" | "confirm" | "chooseEx" | "chooseSide" | "viewText" | "notice" | "dialog";
  /** 可选：dialog close/update 变体不带 title（设计 §6.2/§6.3 的 wire 形状）；notice 沿用空串。 */
  title?: string;
  items?: string[];
  /** chooseSide：item → 横选候选值（仅 valuesOf(item) 非空的项——无横选行前端降级显「——」）。 */
  values?: Record<string, string[]>;
  text?: string;
  secret?: boolean;
  multi?: boolean;
  sideLabel?: string;
  markdown?: boolean;
  durationMs?: number;
  op?: "open" | "update" | "close";
  revision?: number;
  reset?: "selection" | "all" | "none";
  layout?: PopupLayout;
  widgets?: SerializedWidget[];
};

/** 可答交互的 kind（viewText/notice 单向帧不在列）。 */
type AskableKind = Exclude<InteractionFrame["kind"], "viewText" | "notice">;

interface Pending {
  kind: AskableKind;
  frame: InteractionFrame;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface WebCommandUiDeps {
  /** interaction 帧广播口（webCommandUiFactory 接 sse.ts sendInteractionFrame）。 */
  broadcast(frame: InteractionFrame): void;
  /** 等相位出口（可选注入——factory 接 HostedSession.setWaiting：presence + phase 推导）。 */
  presence?: { setWaiting(k: "approval" | "input" | null): void };
  /** harness 只读口（可选注入——factory 接 () => hs.core；relay 的 owner 活性判定用；会话销毁时
   *  经 detachHarness() 置空防悬挂——web-dialog 批 T4）。 */
  harnessRef?: () => Harness | undefined;
}

export class WebCommandUi implements CommandUi {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly deps: WebCommandUiDeps;
  private readonly relay: DialogRelay;
  private harnessRef: (() => Harness | undefined) | undefined;

  /** CommandUi 公共面一律 **箭头函数自有属性**（不用原型方法）：core activate.ts 的 ownerTagUi
   *  包装（viewText/dialog 在场时）以 Object.getOwnPropertyDescriptors 拷贝宿主 ui——原型方法
   *  会丢（本类实现了 viewText 必走该包装；CLI 注入的 readline ui 是对象字面量故无此坑）。 */
  ask = (question: string): Promise<string> =>
    this.hang("ask", { id: this.nextId(), kind: "ask", title: question }) as Promise<string>;

  askSecret = (question: string): Promise<string> =>
    this.hang("askSecret", { id: this.nextId(), kind: "askSecret", title: question, secret: true }) as Promise<string>;

  choose = async (title: string, items: string[]): Promise<string> => {
    if (items.length === 0) throw new Error(t("menu.err.noItems")); // CR-05 同款：空表 = 不可答的挂死卡（无超时），入口即拒
    return this.hang("choose", { id: this.nextId(), kind: "choose", title, items }) as Promise<string>;
  };

  confirm = (question: string): Promise<boolean> =>
    this.hang("confirm", { id: this.nextId(), kind: "confirm", title: question }) as Promise<boolean>;

  chooseEx = async (title: string, items: string[], opts?: { multi?: boolean }): Promise<string[]> => {
    if (items.length === 0) throw new Error(t("menu.err.noItems"));
    return this.hang("chooseEx", {
      id: this.nextId(), kind: "chooseEx", title, items,
      ...(opts?.multi === true ? { multi: true } : {}),
    }) as Promise<string[]>;
  };

  chooseSide = async (title: string, items: string[], opts: { side: { label: string; valuesOf: (item: string) => string[] | undefined; initialOf?: (item: string) => string | undefined } }): Promise<{ item: string; value: string | undefined }> => {
    if (items.length === 0) throw new Error(t("menu.err.noItems"));
    const values: Record<string, string[]> = {};
    for (const it of items) {
      const vs = opts.side.valuesOf(it);
      if (vs !== undefined && vs.length > 0) values[it] = vs; // 无横选项不进 values（前端降级显「——」）
    }
    return this.hang("chooseSide", { id: this.nextId(), kind: "chooseSide", title, items, values, sideLabel: opts.side.label }) as Promise<{ item: string; value: string | undefined }>;
  };

  /** 单向帧（brief：viewText/notice 广播即完成——不进 pending、不设等相位）。opts 收窄到 web 可渲染面
 *  （markdown + layout——web-dialog 批 T4 起 layout 进帧，full/center80 前端走大窗、dock/缺省原路径
 *  零回归；keys 仍不桥）。发出前先关当前 dialog（设计 §5.1 supersede）。owner 不透传——大窗是单向
 *  消息，关闭只在本地（设计 §9）。 */
  viewText = (title: string, text: string, opts?: { markdown?: boolean; layout?: PopupLayout }): void => {
    this.relay.supersede();
    this.deps.broadcast({ id: this.nextId(), kind: "viewText", title, text, ...(opts?.markdown === true ? { markdown: true } : {}), ...(opts?.layout !== undefined ? { layout: opts.layout } : {}) });
  };

  notice = (text: string, opts?: { durationMs?: number }): void => {
    const ms = opts?.durationMs;
    this.deps.broadcast({
      id: this.nextId(), kind: "notice", title: "", text,
      ...(ms !== undefined ? { durationMs: Math.max(1_000, Math.min(30_000, ms)) } : {}), // 契约 [1000,30000] 钳位
    });
  };

  /** 控件窗（web-dialog 批 T4，设计 §5-§7）：开窗进 relay 单活管理——箭头函数自有属性（ownerTagUi
   *  描述符拷贝纪律）；owner 由 core 包装层经 {...spec, owner} 注入（activate.ts:284），relay 据此做
   *  卸载关窗判定。返回句柄被替换后 update/close 静默失效（TUI 排队期同语义）。 */
  dialog = (spec: DialogSpec): DialogHandle | undefined => this.relay.open(spec);

  /** owner 关窗桥面（web-dialog 批 T6）：模块启停端点 diff 出消失模块后逐个调（closeGoneDialogs 的
   *  实例出口——经 webCommandUiOf(hs) 触达，转发 relay.closeByOwner）。 */
  closeDialogsByOwner = (owner: string): void => { this.relay.closeByOwner(owner); };

  constructor(deps: WebCommandUiDeps) {
    this.deps = deps;
    this.harnessRef = deps.harnessRef;
    this.relay = new DialogRelay({
      broadcast: (f: DialogFrame) => this.deps.broadcast(f),
      notice: (txt) => this.notice(txt),
      isOwnerActive: (owner) => {
        const h = this.harnessRef?.();
        return h !== undefined && h.graph().audit().some((a) => a.name === owner && a.state === "active");
      },
      nextId: () => this.nextId(), // 与 askable/viewText 共用 w<seq> 会话内单调序号（设计 §6.1 防撞 id）
    });
  }

  /** relay 只读口（dialog-event 端点 / owner 关窗接线 / 测试——web-dialog 批 T5/T6）。 */
  get dialogRelay(): DialogRelay { return this.relay; }

  /** 会话销毁时摘 harness 引用（防悬挂——工厂 close 钩子调；relay 巡检不再触已拆 core）。 */
  detachHarness(): void { this.harnessRef = undefined; }

  /** 下一帧 id（会话内单调；重放 id 复用——pending 存续期间恒定）。 */
  private nextId(): string {
    this.seq += 1;
    return `w${this.seq}`;
  }

  /** 挂起一个可答交互：**先登记 pending 再广播**（晚连客户端的重放快照与 live 帧同 id 幂等——
   *  极端窗内双投递同帧，answer 按 id 去重不影响正确性）+ 等相位标记（choose 族→approval、
   *  ask 族→input——D3 两族口径）。 */
  private hang(kind: AskableKind, frame: InteractionFrame): Promise<unknown> {
    this.relay.supersede(); // 可答交互公共入口：先关当前 dialog（设计 §5.1——notice 不在此列）
    return new Promise((resolve, reject) => {
      this.pending.set(frame.id, { kind, frame, resolve, reject });
      this.deps.presence?.setWaiting(kind === "ask" || kind === "askSecret" ? "input" : "approval");
      this.deps.broadcast(frame);
    });
  }

  /** settle 纪律：**先删 Map 项再 settle**（防重入双投递）；pending 清空时清等相位。返回 false =
   * 该 id 无挂起（已 settle/未知）——幂等 noop 面。 */
  private settle(id: string, fn: (p: Pending) => void): boolean {
    const p = this.pending.get(id);
    if (p === undefined) return false;
    this.pending.delete(id);
    fn(p);
    if (this.pending.size === 0) this.deps.presence?.setWaiting(null);
    return true;
  }

  /** 取消收场：confirm 折 false（契约 Esc 语义内 fail-closed 不抛错）；其余 reject「已取消（Esc）」
   *  （TUI Esc 同字面量——waterfall 监听者抛错视为否决，bus.ts fail-closed）。 */
  private dispose(p: Pending): void {
    if (p.kind === "confirm") p.resolve(false);
    else p.reject(new Error(ESC_CANCELLED));
  }

  /** POST /answer 落点（§3 应答形态分 kind 归一）：choose=选中项原文（∈ items 契约硬校验——
   *  伪造项 fail-closed reject，防把审批对话框打成放行通道）/ chooseSide={item,value} 对 /
   *  ask|askSecret=文本 / confirm="true"|"false" → boolean / chooseEx=多选数组（成员可含自定义
   *  输入——契约允许，不做成员校验）。返回 false = noop（已 settle/未知 id）。 */
  answer(id: string, value: unknown): boolean {
    return this.settle(id, (p) => {
      try {
        p.resolve(this.valueOf(p.kind, p.frame, value));
      } catch (err) {
        p.reject(err instanceof Error ? err : new Error(String(err))); // 坏应答 fail-closed 带内收场
      }
    });
  }

  /** POST /answer {cancelled:true} 落点：Esc 语义（幂等 noop 同 answer）。 */
  cancel(id: string): void {
    this.settle(id, (p) => this.dispose(p));
  }

  /** HostedSession.close() 关停钩子消费（brief ⑧）：全部挂起 interaction fail-closed 收场 +
   *  等相位清位 + 重放源自清（pending 空）。 */
  failAllPending(): void {
    for (const id of Array.from(this.pending.keys())) {
      this.settle(id, (p) => this.dispose(p));
    }
    this.deps.presence?.setWaiting(null);
  }

  /** 仍挂起的 interaction 帧清单（sse.ts 重连重放源——Map 插入序 = 挂起序，id 复用）。web-dialog 批
   *  T4：活跃 dialog 快照追加在末尾（挂起交互在前、dialog 压顶在后——前端按序渲染；已关窗不重放）。 */
  pendingFrames(): InteractionPayload[] {
    const frames: InteractionPayload[] = Array.from(this.pending.values(), (p) => p.frame);
    const snap = this.relay.snapshotFrame();
    if (snap !== undefined) frames.push(snap);
    return frames;
  }

  /** §3 应答值归一（kind 分派；校验失败抛错 → answer 侧转 fail-closed reject）。 */
  private valueOf(kind: AskableKind, frame: InteractionFrame, value: unknown): unknown {
    switch (kind) {
      case "confirm":
        return value === "true"; // §3：confirm 应答 "true"|"false" 字符串形态
      case "ask":
      case "askSecret":
        return typeof value === "string" ? value : String(value);
      case "choose": {
        if (typeof value !== "string" || !(frame.items ?? []).includes(value)) {
          throw new Error(`应答值不在候选清单内（choose ${frame.id}）`);
        }
        return value;
      }
      case "chooseEx": {
        const arr = Array.isArray(value) ? value : [value];
        return arr.map((x) => (typeof x === "string" ? x : String(x)));
      }
      case "chooseSide": {
        const v = value as { item?: unknown; value?: unknown };
        if (typeof v !== "object" || v === null || typeof v.item !== "string" || !(frame.items ?? []).includes(v.item)) {
          throw new Error(`应答值不在候选清单内（chooseSide ${frame.id}）`);
        }
        return { item: v.item, value: typeof v.value === "string" ? v.value : undefined };
      }
    }
  }
}

// ---------- 会话装配（HostPool 工厂 / 路由查找） ----------

/** 会话 → 该会话的 WebCommandUi（POST /answer 路由经此定位——WeakMap 同 sse.ts interactionSources 模式）。 */
const bySession = new WeakMap<HostedSession, WebCommandUi>();

/** 查会话的交互桥（未装配 = undefined——viewer/headless 池；路由按 noop 处理）。 */
export function webCommandUiOf(hs: HostedSession): WebCommandUi | undefined {
  return bySession.get(hs);
}

/** 与 TUI closeGoneModuleUi 同口径（diff 激活集，不解析 reload report——TUI 注释原话：报表解析在各
 *  调用点口径不一，直接 diff 激活集更稳）。不复用 modules-ui.ts 既有 activeModuleNames（:168）：那个绑
 *  ModulesUiDeps（TUI 面板依赖壳，经 deps.getH() 取 harness），web 侧只有裸 Harness——语义同源、形状
 *  不合，自写 Harness 直参版（web-dialog 批 T6，溯源 4）。 */
export function activeModuleNamesOf(h: Harness): Set<string> {
  return new Set(h.graph().audit().filter((a) => a.state === "active").map((a) => a.name));
}

/** 模块启停端点的关窗接线：reload 前拍活跃集、reload 后 diff——消失模块名下仍在册的窗走服务端关闭
 *  路径（广播 close 帧，不调模块回调——模块代码已随卸载销毁，设计 §5.1/§10）。 */
export function closeGoneDialogs(hs: HostedSession, before: Set<string>): void {
  const ui = webCommandUiOf(hs);
  const h = hs.core;
  if (ui === undefined || h === undefined) return;
  const after = activeModuleNamesOf(h);
  for (const n of before) if (!after.has(n)) ui.closeDialogsByOwner(n);
}

/** HostPool 装配工厂（mod.ts 消费——T2 报告接口确认「T5 装配位置 = HostPool 构造参数」）：每会话
 *  铸一个 WebCommandUi 并完成三件接线——① broadcast 绑该会话（sse.ts sendInteractionFrame）；
 *  ② pending 重放源注册（SSE 每次（重）连接重发仍挂起原帧，id 复用——T3 ⑨ 联动）；③ close 钩子
 *  （全部挂起 fail-closed + 等相位清位 + 重放源摘除）。 */
export function webCommandUiFactory(hs: HostedSession): WebCommandUi {
  const ui = new WebCommandUi({
    broadcast: (frame) => { sendInteractionFrame(hs, frame); },
    presence: { setWaiting: (k) => { hs.setWaiting(k); } }, // presence 落 live.json + phase() 五值推导
    harnessRef: () => hs.core, // relay owner 活性判定（只读口——hosted.ts:200；close 时置空防悬挂）
  });
  bySession.set(hs, ui);
  setPendingInteractionSource(hs, () => ui.pendingFrames());
  hs.onClose(() => {
    ui.failAllPending();
    ui.dialogRelay.closeActive(); // 会话销毁走服务端关窗路径（设计 §6.3——broadcast 对已断流自然无人收）
    ui.detachHarness();
    clearPendingInteractionSource(hs);
  });
  return ui;
}
