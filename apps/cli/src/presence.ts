/** 心跳写器（m5-collab T2，方案 D2/D3/D4/D11/D14）：让「我这个会话」对别的进程可见。
 *  写什么、何时写：状态变化即时写（turn 事件已在总线——loop.ts turn/start·end），慢变字段靠 15s
 *  摸活现读（D2 kimi 同款间隔；fullapp.ts tickTimer 同款 unref 手法），退出删文件（token 校验）。
 *
 *  事件面：h.graph().bus（广播总线——turn/start·turn/end，订阅不抢事件；h.events() 是单订阅者
 *  渲染通道，碰不得〔执行期取证〕）。owner = "host-presence"（宿主内建——架构归位约束 9：不引模块件）。
 *  label/preview/model 派生：无总线事件面（session/label、assistant/message 不上总线）——每次写盘前
 *  现读 history 镜像倒扫派生（label 截 60 对齐标题帽；preview = 末条 assistant text 块尾 40 字压平），
 *  model 现读 h.status()（同步口）。心跳**不**刷新 lastEventAt——它记真实活动（展示与 hang 检测
 *  数据源），摸活只重写文件维持 mtime 新鲜（闲置会话不判死，见 live.ts 文件头）。
 *
 *  挂点：createSession 缝（session-io.ts——TUI/行模式共用）；web 前瞻注记：attach 按 (sid, kind)
 *  参数化，不假设每进程一会话——web server 托管多会话时逐会话 attach 即现成形状。 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeLiveFile, removeLiveFile, type LiveInfo, type SessionEvent } from "@orosus/core";

export const HEARTBEAT_MS = 15_000; // D2：kimi instanceRegistry 同款；过期阈值 90s = 6 拍容错（扫描侧）
const LABEL_CAP = 60; // 存储层截 60 对齐标题帽（D4 两层口径：卡内显示层再取 40）
const PREVIEW_CHARS = 40; // ZCode lastAssistantPreview 化用（其帽 120，我们取 40——一行放得下）

/** PresenceWriter 消费的 harness 窄结构面（测试 fake 友好；真 Harness 结构兼容）。 */
export interface PresenceHarness {
  status(): { model: string };
  history(): Promise<SessionEvent[]>;
  graph(): { bus: { on(type: string, listener: (payload: unknown) => unknown, owner: string): () => void } };
}

type Waiting = "approval" | "input" | null;

interface Attached {
  h: PresenceHarness;
  dir: string;
  info: LiveInfo;
  disposers: (() => void)[];
  timer: ReturnType<typeof setInterval>;
  turnActive: boolean;
  waiting: Waiting;
  endError: boolean; // 上轮 turn/end kind=error（D3 error 态信号——下个 turn/start 清）
}

/** 镜像倒扫末条 session/label（窗口装载的头种子含 label——resume 路径不缺）。 */
const deriveLabel = (events: SessionEvent[]): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "session/label") continue;
    const v = (e as { label?: unknown }).label;
    if (typeof v === "string" && v !== "") return v.slice(0, LABEL_CAP);
  }
  return undefined;
};

/** 镜像倒扫末条 assistant/message 的 text 块拼接，压平空白取尾 40 字（reasoning 不混入）。 */
const derivePreview = (events: SessionEvent[]): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "assistant/message") continue;
    const content = (e as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    let text = "";
    for (const p of content) {
      if (typeof p === "object" && p !== null && (p as { kind?: unknown }).kind === "text") {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") text += t;
      }
    }
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat !== "") return flat.slice(-PREVIEW_CHARS);
  }
  return undefined;
};

export class PresenceWriter {
  private cur: Attached | undefined;

  /** 挂起心跳（重复 attach = 先 dispose 旧 sid——/new、/resume、fork 换会话都再进 createSession，
   *  旧 live.json 不即时清会残留至 90s 判死〔协同卡短现幽灵行〕）。 */
  attach(opts: { h: PresenceHarness; sessionsDir: string; sid: string; kind: "tui" | "line" }): void {
    this.dispose();
    const now = Date.now();
    const a: Attached = {
      h: opts.h,
      dir: join(opts.sessionsDir, opts.sid),
      info: {
        v: 1,
        sid: opts.sid,
        pid: process.pid,
        token: randomUUID(),
        kind: opts.kind,
        phase: "idle",
        startedAt: now,
        lastEventAt: now,
      },
      disposers: [],
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      turnActive: false,
      waiting: null,
      endError: false,
    };
    this.cur = a;
    const bus = opts.h.graph().bus;
    a.disposers.push(
      bus.on("turn/start", () => {
        a.turnActive = true;
        a.waiting = null;
        a.endError = false;
        a.info.lastEventAt = Date.now();
        void this.syncNow(a);
      }, "host-presence"),
      bus.on("turn/end", (payload) => {
        a.turnActive = false;
        a.waiting = null;
        a.endError = (payload as { kind?: unknown } | undefined)?.kind === "error";
        a.info.lastEventAt = Date.now();
        void this.syncNow(a);
      }, "host-presence"),
    );
    a.timer = setInterval(() => void this.syncNow(a), HEARTBEAT_MS);
    a.timer.unref?.();
    void this.syncNow(a);
  }

  /** FullApp 挂起钩子（T5 接线：pendingUi 置位/清空调此处）：kind 区分等审批/等问询两族（D3 细分
   *  信号源——审批 pick→approval、ask 自由文本→input）；null = 清空。非 turn 期忽略（宿主菜单挂起
   *  不是模型在等——/model 选择期不得误报 waiting-approval）。 */
  setWaiting(kind: Waiting): void {
    const a = this.cur;
    if (a === undefined || !a.turnActive || a.waiting === kind) return;
    a.waiting = kind;
    a.info.lastEventAt = Date.now();
    void this.syncNow(a);
  }

  /** 摘牌：清定时器 + 退订总线 + 删自家 live.json（token 校验——防误删同 sid 新化身）。幂等。 */
  dispose(): void {
    const a = this.cur;
    if (a === undefined) return;
    this.cur = undefined;
    clearInterval(a.timer);
    for (const d of a.disposers) {
      try {
        d();
      } catch { /* 退订失败无碍——进程退出路径 */ }
    }
    removeLiveFile(a.dir, a.info.token);
  }

  /** 现读派生字段 + 写盘（事件写与摸活写同路径）。history/status 读失败不炸——写器永不能拖垮宿主
   *  （心跳是伴生件，会话本体优先）；dispose/换挂后迟到的 async 写被 this.cur 守卫拦下。 */
  private async syncNow(a: Attached): Promise<void> {
    let events: SessionEvent[] | undefined;
    try {
      events = await a.h.history();
    } catch {
      events = undefined; // 历史读不出 → label/preview 保持旧值
    }
    if (this.cur !== a) return;
    if (events !== undefined) {
      const label = deriveLabel(events);
      if (label !== undefined) a.info.label = label;
      const preview = derivePreview(events);
      if (preview !== undefined) a.info.preview = preview;
    }
    try {
      a.info.model = a.h.status().model;
    } catch { /* status 读失败 → 模型名保持旧值 */ }
    a.info.phase = a.turnActive ? (a.waiting === "approval" ? "waiting-approval" : a.waiting === "input" ? "waiting-input" : "running") : a.endError ? "error" : "idle";
    try {
      writeLiveFile(a.dir, a.info);
    } catch { /* 盘满/权限——下拍自愈，不炸宿主 */ }
  }
}

/** 宿主级单例（session-io createSession 缝 attach / main 退出路径 dispose）。 */
export const presence = new PresenceWriter();
