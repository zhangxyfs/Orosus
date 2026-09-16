import { describe, it, expect } from "vitest";
import { createEventBus, CORE_POINTS } from "./bus.ts";
import type { DiagSink, DiagRecord } from "../diag/logger.ts";

const memSink = (): DiagSink & { records: DiagRecord[] } => {
  const records: DiagRecord[] = [];
  return { records, write: (r) => void records.push(r), flush: () => Promise.resolve(), close: () => Promise.resolve() };
};

describe("事件总线（§6.5）", () => {
  it("emit：按注册序逐个执行，单个抛错被隔离并记诊断日志", async () => {
    const sink = memSink();
    const bus = createEventBus(sink);
    const seen: string[] = [];
    bus.on("m/ev", () => { seen.push("a"); throw new Error("boom"); }, "mod-a");
    bus.on("m/ev", () => { seen.push("b"); }, "mod-b");
    await bus.emit("m/ev", {});
    expect(seen).toEqual(["a", "b"]);
    expect(sink.records.some((r) => r.lvl === "error" && r.code === "kernel.bus.listener-error")).toBe(true);
  });

  it("waterfall：undefined 通过；首个否决即终局，后续监听者不再收到（monotonic guard）", async () => {
    const bus = createEventBus(memSink());
    const seen: string[] = [];
    bus.on(CORE_POINTS.toolPreExecute, () => { seen.push("a"); return undefined; }, "mod-a");
    bus.on(CORE_POINTS.toolPreExecute, () => { seen.push("b"); return { deny: true, reason: "不允许" }; }, "mod-b");
    bus.on(CORE_POINTS.toolPreExecute, () => { seen.push("c"); return undefined; }, "mod-c");
    const veto = await bus.waterfall(CORE_POINTS.toolPreExecute, { call: 1 });
    expect(veto).toEqual({ deny: true, reason: "不允许" });
    expect(seen).toEqual(["a", "b"]); // c 未收到
  });

  it("waterfall：监听者抛错视为否决（fail-closed）", async () => {
    const bus = createEventBus(memSink());
    bus.on(CORE_POINTS.toolPreExecute, () => { throw new Error("bug"); }, "mod-a");
    const veto = await bus.waterfall(CORE_POINTS.toolPreExecute, {});
    expect(veto).toEqual({ deny: true, reason: "bug" });
  });

  it("reduce：逐环改值，返回 undefined = 不改；抛错 = 忽略该环原值续传", async () => {
    const bus = createEventBus(memSink());
    bus.on(CORE_POINTS.transformContext, (v) => (v as number) + 1, "mod-a");
    bus.on(CORE_POINTS.transformContext, () => undefined, "mod-b");
    bus.on(CORE_POINTS.transformContext, () => { throw new Error("x"); }, "mod-c");
    bus.on(CORE_POINTS.transformContext, (v) => (v as number) * 10, "mod-d");
    expect(await bus.reduce(CORE_POINTS.transformContext, 1)).toBe(20); // ((1+1)→2)→忽略→20
  });

  it("collect：按链序拼接，抛错跳过", async () => {
    const bus = createEventBus(memSink());
    bus.on(CORE_POINTS.steering, () => ["a1", "a2"], "mod-a");
    bus.on(CORE_POINTS.steering, () => { throw new Error("x"); }, "mod-b");
    bus.on(CORE_POINTS.steering, () => undefined, "mod-c");
    bus.on(CORE_POINTS.steering, () => ["d1"], "mod-d");
    expect(await bus.collect<string>(CORE_POINTS.steering)).toEqual(["a1", "a2", "d1"]);
  });

  it("any：should-stop 例外——监听者返回布尔，全部调用后 OR，抛错跳过（D29）", async () => {
    const bus = createEventBus(memSink());
    bus.on(CORE_POINTS.shouldStop, () => false, "mod-a");
    bus.on(CORE_POINTS.shouldStop, () => { throw new Error("x"); }, "mod-b");
    bus.on(CORE_POINTS.shouldStop, () => true, "mod-c");
    bus.on(CORE_POINTS.shouldStop, () => false, "mod-d");
    expect(await bus.any(CORE_POINTS.shouldStop)).toBe(true);
    const bus2 = createEventBus(memSink());
    bus2.on(CORE_POINTS.shouldStop, () => false, "mod-a");
    expect(await bus2.any(CORE_POINTS.shouldStop)).toBe(false);
  });

  it("on 返回 disposer：注销后不再收到", async () => {
    const bus = createEventBus(memSink());
    const seen: string[] = [];
    const off = bus.on("m/ev", () => { seen.push("a"); }, "mod-a");
    await bus.emit("m/ev", {});
    off();
    await bus.emit("m/ev", {});
    expect(seen).toEqual(["a"]);
  });
});
