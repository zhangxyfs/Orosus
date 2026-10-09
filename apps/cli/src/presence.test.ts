import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLiveFile, type SessionEvent } from "@orosus/core";
import { PresenceWriter, HEARTBEAT_MS, type PresenceHarness } from "./presence.ts";

/** 假 harness 三件套：status/history/graph().bus——PresenceWriter 的全部外界依赖。 */
class FakeBus {
  private ls = new Map<string, ((p: unknown) => unknown)[]>();
  on(type: string, l: (p: unknown) => unknown, _owner: string): () => void {
    const arr = this.ls.get(type) ?? [];
    arr.push(l);
    this.ls.set(type, arr);
    return () => {
      const i = arr.indexOf(l);
      if (i >= 0) arr.splice(i, 1);
    };
  }
  fire(type: string, payload: unknown): void {
    for (const l of [...(this.ls.get(type) ?? [])]) l(payload);
  }
  count(type: string): number {
    return this.ls.get(type)?.length ?? 0;
  }
}

const mkFake = (opts: { model?: string; events?: SessionEvent[] } = {}) => {
  const bus = new FakeBus();
  const state = { model: opts.model ?? "GLM-5.3", events: opts.events ?? [] };
  const h: PresenceHarness = {
    status: () => ({ model: state.model }),
    history: () => Promise.resolve(state.events),
    graph: () => ({ bus }),
  };
  return { h, bus, state };
};

const ev = (type: string, fields: Record<string, unknown> = {}): SessionEvent =>
  ({ v: 1, id: `e_${Math.random().toString(36).slice(2)}`, parentId: null, seq: 0, ts: new Date().toISOString(), type, ...fields }) as SessionEvent;

const assistantText = (text: string): SessionEvent =>
  ev("assistant/message", { content: [{ kind: "reasoning", text: "想" }, { kind: "text", text }] });

let dir: string;
beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "orosus-presence-test-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const livePath = (sid: string): string => join(dir, sid);
const readInfo = (sid: string) => readLiveFile(livePath(sid))?.info;
/** 等 presence 的 async syncNow（history await + 写盘）落定——fake history 立即 resolve，微任务两拍足够。 */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

describe("PresenceWriter attach/事件驱动（D3 五值状态机 + D4 label/preview 派生）", () => {
  it("① attach 即写 live.json：字段齐（v/sid/pid/token/kind/phase/startedAt/lastEventAt），初始 phase=idle", async () => {
    const { h } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_a", kind: "tui" });
    await settle();
    const info = readInfo("s_a")!;
    expect(info.v).toBe(1);
    expect(info.sid).toBe("s_a");
    expect(info.pid).toBe(process.pid);
    expect(info.token).not.toBe("");
    expect(info.kind).toBe("tui");
    expect(info.phase).toBe("idle");
    expect(info.startedAt).toBeGreaterThan(0);
    expect(info.lastEventAt).toBe(info.startedAt);
    expect(info.model).toBe("GLM-5.3");
    w.dispose();
  });

  it("② attach 从历史派生 label（截 60）与 preview（尾 40 压平空白），model 现读 status()", async () => {
    const longLabel = "题".repeat(80);
    const { h } = mkFake({ events: [ev("session/label", { label: longLabel }), assistantText(`第一行\n第二行${"尾".repeat(50)}`)] });
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_b", kind: "line" });
    await settle();
    const info = readInfo("s_b")!;
    expect(info.label).toBe("题".repeat(60));
    expect(info.preview).toBe(`第一行 第二行${"尾".repeat(50)}`.slice(-40));
    expect(info.kind).toBe("line");
    w.dispose();
  });

  it("③ turn/start → phase=running、lastEventAt 前进、写盘", async () => {
    const { h, bus } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_c", kind: "tui" });
    await settle();
    const t0 = readInfo("s_c")!.lastEventAt;
    await vi.advanceTimersByTimeAsync(5_000);
    bus.fire("turn/start", { turnId: "t1", model: "GLM-5.3" });
    await settle();
    const info = readInfo("s_c")!;
    expect(info.phase).toBe("running");
    expect(info.lastEventAt).toBeGreaterThan(t0);
    w.dispose();
  });

  it("④ turn/end kind=completed → phase=idle + preview 冻结当轮尾文本", async () => {
    const { h, bus, state } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_d", kind: "tui" });
    await settle();
    bus.fire("turn/start", {});
    state.events = [assistantText("本轮回答正文")];
    bus.fire("turn/end", { kind: "completed" });
    await settle();
    const info = readInfo("s_d")!;
    expect(info.phase).toBe("idle");
    expect(info.preview).toBe("本轮回答正文");
    w.dispose();
  });

  it("⑤ turn/end kind=error → phase=error；kind=interrupted → idle（非 error）", async () => {
    const { h, bus } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_e", kind: "tui" });
    await settle();
    bus.fire("turn/start", {});
    bus.fire("turn/end", { kind: "error" });
    await settle();
    expect(readInfo("s_e")!.phase).toBe("error");
    bus.fire("turn/start", {}); // 下个 turn 清 error
    await settle();
    expect(readInfo("s_e")!.phase).toBe("running");
    bus.fire("turn/end", { kind: "interrupted" });
    await settle();
    expect(readInfo("s_e")!.phase).toBe("idle");
    w.dispose();
  });

  it("⑥ turn 中 setWaiting(approval) → waiting-approval；setWaiting(input) → waiting-input；setWaiting(null) → 回 running", async () => {
    const { h, bus } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_f", kind: "tui" });
    await settle();
    bus.fire("turn/start", {});
    w.setWaiting("approval");
    await settle();
    expect(readInfo("s_f")!.phase).toBe("waiting-approval");
    w.setWaiting("input");
    await settle();
    expect(readInfo("s_f")!.phase).toBe("waiting-input");
    w.setWaiting(null);
    await settle();
    expect(readInfo("s_f")!.phase).toBe("running");
    w.dispose();
  });

  it("⑦ 非 turn 期 setWaiting → 忽略（宿主菜单挂起不误报 waiting——/model 选择期 phase 保持 idle）", async () => {
    const { h } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_g", kind: "tui" });
    await settle();
    w.setWaiting("approval");
    await settle();
    expect(readInfo("s_g")!.phase).toBe("idle");
    w.dispose();
  });

  it("⑧ turn/end 清 waiting（等审批中 turn 收尾 → idle/error 由 kind 定，不残留 waiting）", async () => {
    const { h, bus } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_h", kind: "tui" });
    await settle();
    bus.fire("turn/start", {});
    w.setWaiting("approval");
    bus.fire("turn/end", { kind: "completed" });
    await settle();
    expect(readInfo("s_h")!.phase).toBe("idle");
    w.dispose();
  });
});

describe("PresenceWriter 摸活/dispose/换挂", () => {
  it("⑨ 摸活 15s 一拍：model 现读新值重写盘，lastEventAt 不刷新（闲置不谎报活动）", async () => {
    const { h, state } = mkFake({ events: [assistantText("旧文本")] });
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_i", kind: "tui" });
    await settle();
    const t0 = readInfo("s_i")!.lastEventAt;
    state.model = "GLM-5.4";
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    const info = readInfo("s_i")!;
    expect(info.model).toBe("GLM-5.4"); // 慢变字段走摸活现读（D11）
    expect(info.lastEventAt).toBe(t0); // 心跳不前进活动时间——「多久前活动」诚实
    w.dispose();
  });

  it("⑩ 摸活刷新 label（自动标题首轮问答后落盘——无事件面，心跳兜住）", async () => {
    const { h, state } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_j", kind: "tui" });
    await settle();
    expect(readInfo("s_j")!.label).toBeUndefined();
    state.events = [ev("session/label", { label: "自动起的标题" })];
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(readInfo("s_j")!.label).toBe("自动起的标题");
    w.dispose();
  });

  it("⑪ dispose：删 live.json（token 相符）+ 清定时器（过后不再写）+ 退订总线", async () => {
    const { h, bus } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_k", kind: "tui" });
    await settle();
    expect(existsSync(join(livePath("s_k"), "live.json"))).toBe(true);
    expect(bus.count("turn/start")).toBe(1);
    w.dispose();
    expect(existsSync(join(livePath("s_k"), "live.json"))).toBe(false); // 退出即消失（不等 90s 判死）
    expect(bus.count("turn/start")).toBe(0);
    bus.fire("turn/start", {}); // 退订后事件无落点
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(existsSync(join(livePath("s_k"), "live.json"))).toBe(false);
  });

  it("⑫ dispose 幂等（未 attach/重复调均 noop）", () => {
    const w = new PresenceWriter();
    w.dispose();
    w.dispose();
    expect(true).toBe(true);
  });

  it("⑬ 重复 attach 换会话：旧 sid live.json 即时删（不留 90s 幽灵行）+ 新 sid 挂起", async () => {
    const { h } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_old", kind: "tui" });
    await settle();
    w.attach({ h, sessionsDir: dir, sid: "s_new", kind: "tui" });
    await settle();
    expect(existsSync(join(livePath("s_old"), "live.json"))).toBe(false);
    expect(readInfo("s_new")?.sid).toBe("s_new");
    w.dispose();
  });

  it("⑭ token 防误删：dispose 时盘上已是他人文件（同 sid 新化身）→ 保留不删", async () => {
    const { h } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_x", kind: "tui" });
    await settle();
    const other = new PresenceWriter(); // 同 sid 另一化身（极端竞态：A 晚退 B 已挂）
    other.attach({ h, sessionsDir: dir, sid: "s_x", kind: "tui" });
    await settle();
    const tokenB = readInfo("s_x")!.token;
    // A 的 w 已在 B attach 时被 A 自己 dispose？不——两实例互不知。模拟 A 迟到的 dispose：
    w.dispose();
    expect(readInfo("s_x")?.token).toBe(tokenB); // B 的文件原样保留
    other.dispose();
    expect(readInfo("s_x")).toBeUndefined();
  });

  it("⑮ preview 缺省：history 无 assistant 文本 → preview 字段缺省（不写空串）", async () => {
    const { h } = mkFake({ events: [ev("user/message", { content: [] })] });
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_y", kind: "tui" });
    await settle();
    expect(readInfo("s_y")!.preview).toBeUndefined();
    w.dispose();
  });

  it("⑯ preview 只取 text 块（reasoning 不混进）+ 多文本块拼接", async () => {
    const { h } = mkFake({ events: [ev("assistant/message", { content: [{ kind: "reasoning", text: "推理一大段" }, { kind: "text", text: "前段" }, { kind: "text", text: "后段" }] })] });
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_z", kind: "tui" });
    await settle();
    expect(readInfo("s_z")!.preview).toBe("前段后段");
    w.dispose();
  });

  it("⑰ history 读失败 → 写盘不炸（label/preview 保持旧值，phase/模型照常）", async () => {
    const bus = new FakeBus();
    const h: PresenceHarness = {
      status: () => ({ model: "M" }),
      history: () => Promise.reject(new Error("disk gone")),
      graph: () => ({ bus }),
    };
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_w", kind: "tui" });
    await settle();
    const info = readInfo("s_w")!;
    expect(info.phase).toBe("idle");
    expect(info.model).toBe("M");
    w.dispose();
  });

  it("⑱ turn 事件驱动优先于摸活（事件即写不等拍：turn/start 后立刻读盘已是 running）", async () => {
    const { h, bus } = mkFake();
    const w = new PresenceWriter();
    w.attach({ h, sessionsDir: dir, sid: "s_v", kind: "tui" });
    await settle();
    bus.fire("turn/start", {});
    await settle(); // 零定时器推进——纯事件路径
    expect(readInfo("s_v")!.phase).toBe("running");
    w.dispose();
  });
});
