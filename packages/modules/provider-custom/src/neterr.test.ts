import { describe, it, expect } from "vitest";
import type { Chunk, ProviderRequest } from "@orosus/contracts/provider";
import { createStream as openaiStream } from "./stream-openai.ts";
import { createStream as anthropicStream } from "./stream-anthropic.ts";
import { netErrorDetail } from "./neterr.ts";

const baseReq = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: "m", system: "", messages: [{ role: "user", content: [{ kind: "text", text: "q" }] }],
  tools: [], signal: new AbortController().signal, ...over,
});

const collect = async (s: AsyncIterable<Chunk>): Promise<Chunk[]> => {
  const out: Chunk[] = [];
  for await (const c of s) out.push(c);
  return out;
};

// 2026-09-30 拍板 a/b：传输层失败（fetch/读流抛错）打 errorCode "network" 供 loop 零产出重发；
// errorMessage 带全 err.cause 链（此前只记 "fetch failed" 一层皮——真因无从查，150s 挂起无迹可寻实锤）。
describe("网络错误打码与 cause 链（拍板 a/b）", () => {
  it("① netErrorDetail：两层 cause 链拼接、同文去重、非 Error 输入 String 兜底", () => {
    const cause = new Error("Connect Timeout Error (10s)", { cause: new Error("SocketError: other side closed") });
    const err = new TypeError("fetch failed", { cause });
    expect(netErrorDetail(err)).toBe("fetch failed；cause: Connect Timeout Error (10s)；cause: SocketError: other side closed");
    expect(netErrorDetail(new Error("fetch failed", { cause: new Error("fetch failed") }))).toBe("fetch failed"); // 同文去重（防 cause 自引用式重复刷屏）
    expect(netErrorDetail("boom")).toBe("boom");
    expect(netErrorDetail(undefined)).toBe("undefined");
  });

  it("② anthropic 族：fetch 抛错（undici 形态 cause 链）→ finish error + errorCode network + 详情带链", async () => {
    const err = new TypeError("fetch failed", { cause: new Error("Connect Timeout Error (10s)") });
    const fetchImpl = (async () => { throw err; }) as typeof fetch;
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl })(baseReq()));
    expect(chunks).toEqual([{ type: "finish", kind: "error", errorMessage: "网络错误：fetch failed；cause: Connect Timeout Error (10s)", errorCode: "network" }]);
  });

  it("③ openai 族：fetch 抛错同打码同链（两协议面同源）", async () => {
    const err = new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    const fetchImpl = (async () => { throw err; }) as typeof fetch;
    const chunks = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl })(baseReq()));
    expect(chunks).toEqual([{ type: "finish", kind: "error", errorMessage: "网络错误：fetch failed；cause: read ECONNRESET", errorCode: "network" }]);
  });

  it("④ 读流中途抛错（响应体断连）→ 流读取错误同打 network 码（loop 侧零产出门把关重发安全性）", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"前\"}}]}\n\n"));
        setTimeout(() => c.error(new Error("aborted ECONNRESET 32")), 10); // 异步断连——首块先送达（同步 error 会连队列一起丢）
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const chunks = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl })(baseReq()));
    expect(chunks.some((c) => c.type === "text/delta")).toBe(true); // 已产出正文保留
    expect(chunks.at(-1)).toEqual({ type: "finish", kind: "error", errorMessage: "流读取错误：aborted ECONNRESET 32", errorCode: "network" });
  });

  it("⑤ 空闲超时不打 network 码（回归钉：300s 无进展重发大概率同命运且误伤长思考流——语义单独可辨）", async () => {
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const signal = init!.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(c) { signal.addEventListener("abort", () => c.error(signal.reason), { once: true }); },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl, idleTimeoutMs: 30 })(baseReq()));
    const last = chunks.at(-1) as { kind: string; errorMessage?: string; errorCode?: string };
    expect(last.kind).toBe("error");
    expect(last.errorMessage).toContain("空闲超时");
    expect(last.errorCode).toBeUndefined();
  });
});
