import { describe, it, expect } from "vitest";
import { fakeModule, fakeProvider, fakeProviderModule } from "./index.ts";
import { MODULE_API_VERSION } from "@orosus/contracts/module";
import type { Chunk, ProviderRequest } from "@orosus/contracts/provider";

const req = (signal: AbortSignal): ProviderRequest => ({ model: "fake", system: "", messages: [], tools: [], signal });

const collect = async (stream: AsyncIterable<Chunk>): Promise<Chunk[]> => {
  const out: Chunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
};

describe("fakeProvider 取消语义（CT-05 回归钉）", () => {
  it("CT-05 ①流中 abort——剩余段不播，改产 finish{aborted} 带内收尾（对齐真实适配器契约）", async () => {
    const { stream } = fakeProvider([
      [{ type: "text/delta", text: "a" }, { type: "text/delta", text: "b" }, { type: "finish", kind: "stop" }],
    ]);
    const ctl = new AbortController();
    const out: Chunk[] = [];
    for await (const c of stream(req(ctl.signal))) {
      out.push(c);
      if (c.type === "text/delta" && c.text === "a") ctl.abort(); // 首段送达后取消——次段起改走收尾
    }
    expect(out).toEqual([{ type: "text/delta", text: "a" }, { type: "finish", kind: "aborted" }]);
  });

  it("CT-05 ②请求进来前已 abort——脚本一段都不播，首 chunk 即 finish{aborted}", async () => {
    const { stream } = fakeProvider([[{ type: "text/delta", text: "x" }, { type: "finish", kind: "stop" }]]);
    const ctl = new AbortController();
    ctl.abort();
    expect(await collect(stream(req(ctl.signal)))).toEqual([{ type: "finish", kind: "aborted" }]);
  });

  it("未 abort 时照播整段（含 finish{stop}）——快乐路径不受取消语义影响", async () => {
    const { stream } = fakeProvider([[{ type: "text/delta", text: "x" }, { type: "finish", kind: "stop" }]]);
    expect(await collect(stream(req(new AbortController().signal)))).toEqual([
      { type: "text/delta", text: "x" },
      { type: "finish", kind: "stop" },
    ]);
  });
});

describe("fakeProvider 钳位口径（CT-05 既有缺省行为钉）", () => {
  it("脚本耗尽后静默重复末段（不炸不换段）——jobs.test.ts「末段重复无害」同款口径", async () => {
    const first: Chunk[] = [{ type: "text/delta", text: "1" }, { type: "finish", kind: "stop" }];
    const last: Chunk[] = [{ type: "text/delta", text: "2" }, { type: "finish", kind: "stop" }];
    const { stream, requests } = fakeProvider([first, last]);
    await collect(stream(req(new AbortController().signal)));
    await collect(stream(req(new AbortController().signal)));
    expect(await collect(stream(req(new AbortController().signal)))).toEqual(last); // 第 3 发钳位重复末段
    expect(requests).toHaveLength(3); // requests 收集全部请求供断言
  });
});

describe("fake 基建 api 版本同源（CT-06 回归钉）", () => {
  it("fakeModule/fakeProviderModule 的 api 恒等于 MODULE_API_VERSION——契约升档后 fake 不静默停在旧代", () => {
    expect(fakeModule("m").api).toBe(MODULE_API_VERSION);
    expect(fakeProviderModule("p", []).api).toBe(MODULE_API_VERSION);
  });
});
