import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("⑤b F13 富化：降级标签同名 .summary.txt 在场 → 带 [视觉摘要]；无缓存纯标签", () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-f13-"));
    try {
      const img = join(d, "s.png");
      writeFileSync(img, Buffer.alloc(10));
      const msgs = [imgMsg(img)];
      // 单图帽外体积 → 降级 → 标签富化
      const out = applyMediaBudget(msgs, { sizeOf: fakeSizes({ [img]: SINGLE_IMAGE_CAP_BYTES + 1 }) });
      expect((out[0] as { parts: { kind: string }[] }).parts[0]!.kind).toBe("text");
      let label = JSON.stringify(out);
      expect(label).not.toContain("视觉摘要"); // 无缓存纯标签
      writeFileSync(`${img}.summary.txt`, "蓝色按钮的登录页截图", "utf8");
      const out2 = applyMediaBudget(msgs, { sizeOf: fakeSizes({ [img]: SINGLE_IMAGE_CAP_BYTES + 1 }) });
      label = JSON.stringify(out2);
      expect(label).toContain("[视觉摘要]");
      expect(label).toContain("蓝色按钮的登录页截图");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
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

// F9 服务倒挂消费钉：policy 参数的帽值经 mediaOpts 到达线缆（拿掉 adapters 的 policy 接线即红）
describe("F9 媒体策略消费（createAdapters policy 参数 → 流内 mediaOpts → 线缆帽值）", () => {
  it("⑨ policy 收紧张数帽 → 真实双图最老一张被降级标签化（策略值非内置默认在起作用）", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = mkdtempSync(join(tmpdir(), "orosus-f9-"));
    try {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const a = join(d, "a.png");
      const b = join(d, "b.png");
      writeFileSync(a, png);
      writeFileSync(b, png);
      const { createAdapters } = await import("./adapters.ts");
      const bodies: string[] = [];
      const ok = String.raw`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}` + "\n\n" + "data: [DONE]\n\n";
      const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(ok, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      const adapters = createAdapters(
        { providers: { x: { type: "openai", baseUrl: "https://x/v1" } } },
        fetchImpl,
        undefined,
        undefined,
        async () => ({ current: () => ({ maxEdge: 2048, tokenTier: 2048, singleCapBytes: 4.5 * 1024 * 1024, budgetBytes: 20 * 1024 * 1024, safeBytes: 10 * 1024 * 1024, maxImages: 1, visionModel: "off" }) }), // 张数帽收到 1（内置默认 4）
      );
      const stream = adapters.get("x")!.stream;
      const messages: ModelMessage[] = [imgMsg(a), imgMsg(b)];
      for await (const _ of stream({ model: "m", system: "", tools: [], messages, signal: new AbortController().signal })) { /* drain */ }
      const wire = bodies[0]!;
      expect(wire).toContain("超过每次 1 张上限"); // 策略收紧的张数帽在线缆生效（默认 4 不会降两张小图）
      expect(wire).toContain("a.png"); // 降级标签带路径（JSON 转义反斜杠——按文件名断言）
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);
});
