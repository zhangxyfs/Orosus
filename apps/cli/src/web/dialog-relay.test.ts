import { describe, it, expect, vi, afterEach } from "vitest";
import type { DialogSpec, WidgetSpec } from "@orosus/contracts/module";
import { DialogRelay, type DialogFrame, type RelayDialogHandle, type SerializedWidget } from "./dialog-relay.ts";

/** 联合帧类型经数组索引访问不窄化——统一经 wid() 取 widgets。 */
const wid = (f: DialogFrame | undefined): SerializedWidget[] | undefined =>
  (f as { widgets?: SerializedWidget[] } | undefined)?.widgets;

/** 测试台：捕获广播帧（深拷贝防后续变异干扰断言）与 notice；owner 活跃集可变（巡检用例）。 */
const rig = () => {
  const frames: DialogFrame[] = [];
  const notices: string[] = [];
  const activeOwners = new Set<string>(["mod-a"]);
  let seq = 0;
  const relay = new DialogRelay({
    broadcast: (f) => frames.push(JSON.parse(JSON.stringify(f)) as DialogFrame),
    notice: (t) => notices.push(t),
    isOwnerActive: (o) => activeOwners.has(o),
    nextId: () => `w${++seq}`,
  });
  return { relay, frames, notices, activeOwners };
};

const text = (text: string): WidgetSpec => ({ id: "t", kind: "text", text });
const list = (items: string[]): WidgetSpec => ({ id: "l", kind: "list", interactive: true, items });

const spec = (widgets: WidgetSpec[], extra: Partial<DialogSpec> = {}): DialogSpec =>
  ({ title: "测试窗", widgets, ...extra });

afterEach(() => { vi.useRealTimers(); });

describe("dialog-relay：序列化与快照（设计 12.1-1/7）", () => {
  it("① 8 种控件 + 嵌套 columns：函数求值进帧、原 spec 不被修改、帧内无函数", () => {
    const { relay, frames } = rig();
    const sp = spec([
      { id: "t", kind: "text", text: () => "活文本" },
      { id: "k", kind: "kv", label: "键", value: () => "活值" },
      { id: "s", kind: "sep" },
      list(["a", "b"]),
      { id: "p", kind: "progress", value: () => 0.5, max: 1 },
      { id: "i", kind: "input", label: "输入", multiline: true, lines: 3, enterSubmit: true, placeholder: "占位" },
      { id: "c", kind: "columns", cols: [[{ id: "ct", kind: "text", text: () => "列内活文本" }], [{ id: "cp", kind: "progress", value: () => 0.25, max: 1 }]], widths: [2, 1] },
      { id: "tb", kind: "table", head: ["列一", "列二"], rows: [["r1c1", "r1c2"]] },
    ]);
    const before = JSON.parse(JSON.stringify(sp, (_k, v) => (typeof v === "function" ? "FN" : v)));
    relay.open(sp);
    const open = frames.find((f) => f.op === "open")!;
    expect(open.kind).toBe("dialog");
    expect(open.revision).toBe(1);
    expect(open.title).toBe("测试窗");
    expect(JSON.stringify(open)).not.toContain("function");
    const widgets = wid(open)!;
    expect(widgets[0]).toMatchObject({ id: "t", kind: "text", text: "活文本" });
    expect(widgets[1]).toMatchObject({ id: "k", kind: "kv", value: "活值" });
    expect(widgets[4]).toMatchObject({ id: "p", kind: "progress", value: 0.5 });
    expect(widgets[6]).toMatchObject({ id: "c", kind: "columns", widths: [2, 1] });
    const cols = (widgets[6] as Extract<SerializedWidget, { kind: "columns" }>).cols;
    expect(cols[0]![0]).toMatchObject({ text: "列内活文本" });
    expect(cols[1]![0]).toMatchObject({ value: 0.25 });
    const after = JSON.parse(JSON.stringify(sp, (_k, v) => (typeof v === "function" ? "FN" : v)));
    expect(after).toEqual(before); // 原 spec 不被修改（含函数字段原样保留）
  });

  it("② 动态值变化才广播：无变化静默、有变化发 reset:none 且 revision 递增", () => {
    vi.useFakeTimers();
    const { relay, frames } = rig();
    let v = "甲";
    relay.open(spec([{ id: "t", kind: "text", text: () => v }]));
    expect(frames.length).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(1); // 值未变：不广播
    v = "乙";
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(2);
    expect(frames[1]).toMatchObject({ op: "update", reset: "none", revision: 2 });
    expect(wid(frames[1])![0]).toMatchObject({ text: "乙" });
  });

  it("③ 求值异常：有上一版值保留上一版；首帧无值用占位（文本「（动态值暂不可用）」/progress 0）", () => {
    vi.useFakeTimers();
    const { relay, frames } = rig();
    let boom = false;
    let v = "好值";
    relay.open(spec([
      { id: "t", kind: "text", text: () => { if (boom) throw new Error("炸"); return v; } },
      { id: "p", kind: "progress", value: () => { if (boom) throw new Error("炸"); return 0.4; }, max: 1 },
    ]));
    boom = true; v = "新值";
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(1); // 异常保留上一版 = 序列化结果未变 → 不广播
    expect(wid(frames[0])![0]).toMatchObject({ text: "好值" });
    // 首帧即异常 → 占位
    const { relay: r2, frames: f2 } = rig();
    r2.open(spec([
      { id: "t", kind: "text", text: () => { throw new Error("首帧就炸"); } },
      { id: "p", kind: "progress", value: () => { throw new Error("首帧就炸"); }, max: 1 },
    ]));
    expect(wid(f2[0])![0]).toMatchObject({ text: "（动态值暂不可用）" });
    expect(wid(f2[0])![1]).toMatchObject({ value: 0 });
  });

  it("④ close 清 timer：关窗后推进 5s 无任何新帧", () => {
    vi.useFakeTimers();
    const { relay, frames } = rig();
    let v = "甲";
    relay.open(spec([{ id: "t", kind: "text", text: () => v }]));
    relay.closeActive();
    v = "乙";
    vi.advanceTimersByTime(5000);
    expect(frames.length).toBe(2); // open + close，仅此
    expect(frames[1]).toMatchObject({ op: "close" });
  });
});

describe("dialog-relay：句柄与事件（设计 12.1-2/3/4/5 + §6.4）", () => {
  it("⑤ handle.update：revision+1、reset:selection、内容相同也发送（滚回顶是契约行为）", () => {
    const { relay, frames } = rig();
    const h = relay.open(spec([list(["a"])]))!;
    frames.length = 0;
    h.update([list(["a"])]); // 与当前内容相同
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatchObject({ op: "update", reset: "selection", revision: 2 });
  });

  it("⑥ onEvent 返回数组 = reset:all 整窗重发；返回 void 不发帧", () => {
    const { relay, frames } = rig();
    let calls = 0;
    const h = relay.open(spec([list(["a"])], { onEvent: () => { calls += 1; return calls === 1 ? [list(["换过的"])] : undefined; } }))!;
    frames.length = 0;
    const r1 = relay.event(h.idOf(), { type: "select", id: "l", index: 0 });
    expect(r1).toEqual({ ok: true, revision: 2 });
    expect(frames[0]).toMatchObject({ op: "update", reset: "all", revision: 2 });
    expect(wid(frames[0])![0]).toMatchObject({ items: ["换过的"] });
    frames.length = 0;
    const r2 = relay.event(h.idOf(), { type: "select", id: "l", index: 0 });
    expect(r2).toEqual({ ok: true, revision: 2 });
    expect(frames.length).toBe(0); // void 不重画
  });

  it("⑦ 回调内 close 后不发旧 update（record 重确认）；回执 closed:true", () => {
    const { relay, frames } = rig();
    let handle: RelayDialogHandle | undefined;
    const sp = spec([list(["a"])], { onEvent: () => { handle!.close(); return [list(["迟到的更新"])]; } });
    handle = relay.open(sp);
    frames.length = 0;
    const r = relay.event(handle.idOf(), { type: "select", id: "l", index: 0 });
    expect(r).toEqual({ ok: true, closed: true });
    expect(frames.some((f) => f.op === "update")).toBe(false); // 过期 update 被丢弃
    expect(frames.some((f) => f.op === "close")).toBe(true);
  });

  it("⑧ 单活替换：新 open 前先广播旧 close；旧句柄 update/close 静默无操作；supersede 同序", () => {
    const { relay, frames } = rig();
    const a = relay.open(spec([text("A")]))!;
    frames.length = 0;
    const b = relay.open(spec([text("B")]))!;
    expect(frames.map((f) => f.op)).toEqual(["close", "open"]); // 旧 close → 新 open
    expect(frames[0]).toMatchObject({ id: a.idOf() });
    expect(frames[1]).toMatchObject({ id: b.idOf(), revision: 1 });
    frames.length = 0;
    a.update([text("A2")]);
    a.close();
    expect(frames.length).toBe(0); // 旧句柄静默失效
    // supersede：viewText/可答交互前关当前窗
    relay.supersede();
    expect(frames.map((f) => f.op)).toEqual(["close"]);
    expect(relay.snapshotFrame()).toBeUndefined();
  });

  it("⑨ onEvent 抛错：notice「控件窗事件处理出错」、窗保留（snapshotFrame 仍在）", () => {
    const { relay, notices } = rig();
    const h = relay.open(spec([list(["a"])], { onEvent: () => { throw new Error("模块炸了"); } }))!;
    const r = relay.event(h.idOf(), { type: "select", id: "l", index: 0 });
    expect(r).toEqual({ ok: true });
    expect(notices).toEqual(["控件窗事件处理出错"]);
    expect(relay.snapshotFrame()).toBeDefined();
  });
});

describe("dialog-relay：事件语义校验（设计 §6.4——浏览器不可信，服务端把关）", () => {
  it("⑩ noop 族：未知 id/已关窗/控件消失/越界 index/类型不匹配——一律不调 onEvent", () => {
    const { relay } = rig();
    let calls = 0;
    const h = relay.open(spec([list(["a", "b"]), { id: "i", kind: "input" }], { onEvent: () => { calls++; } }))!;
    expect(relay.event("w999", { type: "select", id: "l", index: 0 })).toEqual({ ok: true, noop: true }); // 未知 id
    expect(relay.event(h.idOf(), { type: "select", id: "gone", index: 0 })).toEqual({ ok: true, noop: true }); // 控件消失
    expect(relay.event(h.idOf(), { type: "select", id: "l", index: 9 })).toEqual({ ok: true, noop: true }); // 越界
    expect(relay.event(h.idOf(), { type: "select", id: "l", index: 1.5 })).toEqual({ ok: true, noop: true }); // 非整数
    expect(relay.event(h.idOf(), { type: "input", id: "l", text: "x" })).toEqual({ ok: true, noop: true }); // input 事件→非 input 控件
    expect(relay.event(h.idOf(), { type: "select", id: "i", index: 0 })).toEqual({ ok: true, noop: true }); // select→非 interactive list
    expect(calls).toBe(0);
    relay.closeActive();
    expect(relay.event(h.idOf(), { type: "select", id: "l", index: 0 })).toEqual({ ok: true, noop: true }); // 已关窗
    expect(calls).toBe(0);
  });

  it("⑪ 合法面：select/activate(list) 带 index、activate(input) 不带 index、input 事件均回调", () => {
    const { relay } = rig();
    const seen: unknown[] = [];
    const h = relay.open(spec([list(["a", "b"]), { id: "i", kind: "input", enterSubmit: true }], { onEvent: (e) => { seen.push(e); } }))!;
    expect(relay.event(h.idOf(), { type: "select", id: "l", index: 1 })).toMatchObject({ ok: true });
    expect(relay.event(h.idOf(), { type: "activate", id: "l", index: 1 })).toMatchObject({ ok: true });
    expect(relay.event(h.idOf(), { type: "input", id: "i", text: "打字" })).toMatchObject({ ok: true });
    expect(relay.event(h.idOf(), { type: "activate", id: "i" })).toMatchObject({ ok: true }); // input 回车激活：不带 index（契约 DialogEvent）
    expect(seen.map((e) => (e as { type: string }).type)).toEqual(["select", "activate", "input", "activate"]);
  });

  it("⑫ owner 不活跃安全网：event 到达时先关窗再回 noop（迟到事件不复活窗口）", () => {
    const { relay, frames, activeOwners } = rig();
    let calls = 0;
    const h = relay.open(spec([list(["a"])], { owner: "mod-a", onEvent: () => { calls++; } }))!;
    activeOwners.delete("mod-a");
    frames.length = 0;
    expect(relay.event(h.idOf(), { type: "select", id: "l", index: 0 })).toEqual({ ok: true, noop: true });
    expect(frames.some((f) => f.op === "close")).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("dialog-relay：owner 巡检与关窗（设计 12.1-9 relay 面 + §5.1）", () => {
  it("⑬ closeByOwner：owner 匹配当前 record 才关，不匹配不动", () => {
    const { relay, frames } = rig();
    relay.open(spec([text("x")], { owner: "mod-a" }));
    relay.closeByOwner("mod-b");
    expect(relay.snapshotFrame()).toBeDefined();
    relay.closeByOwner("mod-a");
    expect(relay.snapshotFrame()).toBeUndefined();
    expect(frames.at(-1)).toMatchObject({ op: "close" });
  });

  it("⑭ 1s 巡检：owner 消失自动关窗 + notice 用 TUI 同款文案（带 owner 名）；无函数值也巡检", () => {
    vi.useFakeTimers();
    const { relay, frames, notices, activeOwners } = rig();
    relay.open(spec([text("静态")], { owner: "mod-a" })); // 无函数值：timer 仍为巡检保留
    frames.length = 0;
    activeOwners.delete("mod-a");
    vi.advanceTimersByTime(1000);
    expect(frames.map((f) => f.op)).toEqual(["close"]);
    expect(notices).toEqual(["模块 mod-a 已卸载——其窗口已关闭"]);
    expect(relay.snapshotFrame()).toBeUndefined();
  });

  it("⑮ snapshotFrame：活跃才存在、revision 跟随最新、layout 缺省不进帧", () => {
    const { relay } = rig();
    expect(relay.snapshotFrame()).toBeUndefined();
    const h = relay.open(spec([list(["a"])]))!;
    h.update([list(["b"])]);
    const snap = relay.snapshotFrame()!;
    expect(snap).toMatchObject({ op: "open", revision: 2, title: "测试窗" });
    expect("layout" in snap && snap.layout !== undefined).toBe(false); // 未声明 layout 不进帧
    const withLayout = rig();
    const h2 = withLayout.relay.open(spec([text("x")], { layout: "full" }))!;
    expect(withLayout.relay.snapshotFrame()).toMatchObject({ layout: "full", id: h2.idOf() });
  });
});
