import { describe, it, expect } from "vitest";
import type { ModelMessage } from "@orosus/contracts/provider";
import {
  applyMediaBudget, DEFAULT_ACCEPTED_IMAGE_MIMES, imageTag,
  MAX_IMAGES_PER_REQUEST, REQUEST_MEDIA_BUDGET_BYTES, REQUEST_MEDIA_BUDGET_LOW_BYTES, SINGLE_IMAGE_CAP_BYTES,
} from "./mediabudget.ts";

const MB = 1024 * 1024;

const imgMsg = (path: string, mimeType: "image/png" | "image/webp" = "image/png", output = "o"): ModelMessage => ({
  role: "toolResult", callId: `c-${path}`, output, isError: false,
  parts: [{ kind: "image", path, mimeType }],
});

const fakeSizes = (sizes: Record<string, number>) => (path: string): number | undefined => sizes[path];

describe("applyMediaBudget（F6 mime 门控 + F7 预算降级——四道闸）", () => {
  it("① 无图 / 全达标 → 原引用直返（常用路径零分配零开销）", () => {
    const plain: ModelMessage[] = [{ role: "user", content: [{ kind: "text", text: "纯文本" }] }];
    expect(applyMediaBudget(plain)).toBe(plain);
    const ok: ModelMessage[] = [imgMsg("/m/a.png"), imgMsg("/m/b.png")];
    expect(applyMediaBudget(ok, { sizeOf: fakeSizes({ "/m/a.png": 100, "/m/b.png": 200 }) })).toBe(ok);
  });

  it("② mime 门控（F6）：端点不认 webp → 该图换文字标签（路径保留），png 照发", () => {
    const msgs = [imgMsg("/m/a.webp", "image/webp"), imgMsg("/m/b.png")];
    const out = applyMediaBudget(msgs, { acceptedMimes: ["image/png", "image/jpeg"], sizeOf: fakeSizes({ "/m/a.webp": 10, "/m/b.png": 10 }) });
    const parts = (out[0] as { parts: { kind: string; text?: string }[] }).parts;
    expect(parts[0]!.kind).toBe("text");
    expect(parts[0]!.text).toContain('<image path="/m/a.webp"');
    expect(parts[0]!.text).toContain("该端点不认 image/webp");
    expect((out[1] as { parts: unknown[] }).parts[0]).toMatchObject({ kind: "image" }); // png 存活
    expect(DEFAULT_ACCEPTED_IMAGE_MIMES).toContain("image/gif"); // 缺省白名单四格式
  });

  it("③ 单图帽 4.5MB：超帽图换标签（体积明示）；同图多处引用一致降级", () => {
    const msgs: ModelMessage[] = [
      imgMsg("/m/huge.png"),
      { role: "user", content: [{ kind: "text", text: "再看一次" }, { kind: "image", path: "/m/huge.png", mimeType: "image/png" }] },
    ];
    const out = applyMediaBudget(msgs, { sizeOf: fakeSizes({ "/m/huge.png": SINGLE_IMAGE_CAP_BYTES + 1 }) });
    expect((out[0] as { parts: { kind: string }[] }).parts[0]!.kind).toBe("text");
    expect((out[1] as { content: { kind: string }[] }).content[1]!.kind).toBe("text"); // 第二处引用同步降级
    const text = JSON.stringify(out);
    expect(text).toContain("超单图帽");
  });

  it("④ 张数帽 4：第 5 张起最老的换标签（最新 4 张存活）", () => {
    const msgs = [imgMsg("/m/1.png"), imgMsg("/m/2.png"), imgMsg("/m/3.png"), imgMsg("/m/4.png"), imgMsg("/m/5.png")];
    const sizes = Object.fromEntries(msgs.map((_, i) => [`/m/${i + 1}.png`, 1000]));
    const out = applyMediaBudget(msgs, { sizeOf: fakeSizes(sizes) });
    expect((out[0] as { parts: { kind: string }[] }).parts[0]!.kind).toBe("text"); // 最老降级
    for (let i = 1; i < 4; i++) expect((out[i] as { parts: { kind: string }[] }).parts[0]!.kind).toBe("image");
    expect(MAX_IMAGES_PER_REQUEST).toBe(4);
  });

  it("⑤ 总量帽超线 → 降级到安全线：从最老开始丢、丢够即停（kimi applyMediaBudget 同款；默认帽下单图帽×张数帽已封顶 18MB<20MB，预算闸面向收紧配置的重度走查场景）", () => {
    // 3×4MB（各≤单图帽、张数≤4）：总 12MB > 帽 10MB → 降最老（8MB 仍 >5 安全线 → 再降中间）→ 4MB ≤5 停
    const msgs = [imgMsg("/m/old.png"), imgMsg("/m/mid.png"), imgMsg("/m/new.png")];
    const size = 4 * MB;
    const out = applyMediaBudget(msgs, { budgetBytes: 10 * MB, safeBytes: 5 * MB, sizeOf: fakeSizes({ "/m/old.png": size, "/m/mid.png": size, "/m/new.png": size }) });
    expect((out[0] as { parts: { kind: string }[] }).parts[0]!.kind).toBe("text"); // 最老降
    expect((out[1] as { parts: { kind: string }[] }).parts[0]!.kind).toBe("text"); // 中间也降（8MB 仍超 5MB 安全线）
    expect((out[2] as { parts: { kind: string }[] }).parts[0]!.kind).toBe("image"); // 最新存活（4MB ≤ 5MB）
    expect(REQUEST_MEDIA_BUDGET_BYTES).toBe(20 * MB);
    expect(REQUEST_MEDIA_BUDGET_LOW_BYTES).toBe(10 * MB);
  });

  it("⑥ 文件缺失不占预算（translate 层自有缺失降级）；imageTag 形态", () => {
    const msgs = [imgMsg("/m/ghost.png")];
    expect(applyMediaBudget(msgs, { sizeOf: () => undefined })).toBe(msgs); // 缺失不降级不炸
    expect(imageTag("/m/x.png")).toBe('<image path="/m/x.png">');
    expect(imageTag("/m/x.png", "测试原因")).toBe('<image path="/m/x.png" reason="测试原因">');
  });
});

describe("F7 stream 装配钉（openai/anthropic——拿掉 applyMediaBudget 调用即红）", () => {
  it("⑦ openai 族：超张数帽 → 线缆只余 4 张 image_url、最老的换标签文本", async () => {
    const { createStream } = await import("./stream-openai.ts");
    const bodies: string[] = [];
    const ok = String.raw`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}` + "\n\n" + "data: [DONE]\n\n";
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(ok, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const messages = [1, 2, 3, 4, 5].map((i) => imgMsg(`Z:/nope-${i}.png`)); // 文件缺失——预算层不降级，但张数帽按 sizeOf=undefined 不占 → 不会降级……
    // 张数帽只数能 stat 到的图；缺失文件由 translate 层缺失降级——本钉改为 mime 门控（确定性）：
    const webpMsgs = [imgMsg("Z:/w-1.webp", "image/webp")];
    const req = { model: "m", system: "", tools: [], messages: [...messages.slice(0, 2), ...webpMsgs], signal: new AbortController().signal };
    for await (const _ of createStream({ baseUrl: "https://x/v1", fetchImpl, acceptedImageMimes: ["image/png"], catalogFile: "Z:/nope/catalog.json" })(req as never)) { /* drain */ }
    const wire = bodies[0]!;
    expect(wire).toContain("该端点不认 image/webp");
    expect(wire).toContain("<image path="); // JSON 转义引号不定形——按标签前缀断言
    expect(wire).toContain("Z:/w-1.webp"); // 路径保留（可再读）
  });

  it("⑧ anthropic 族：mime 门控同样生效（线缆零 webp 图块）", async () => {
    const { createStream } = await import("./stream-anthropic.ts");
    const bodies: string[] = [];
    const sse = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const req = { model: "m", system: "", tools: [], messages: [imgMsg("Z:/w.webp", "image/webp")], signal: new AbortController().signal };
    for await (const _ of createStream({ baseUrl: "https://x", fetchImpl, acceptedImageMimes: ["image/png"], catalogFile: "Z:/nope/catalog.json" })(req as never)) { /* drain */ }
    expect(bodies[0]!).toContain("该端点不认 image/webp");
  });
});
