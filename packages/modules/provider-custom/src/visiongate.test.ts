import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ProviderRequest } from "@orosus/contracts/provider";
import { gateImagesByVision, nonVisionImagePlaceholder, resetVisionGateForTest, stripImageParts } from "./visiongate.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
  resetVisionGateForTest();
});

const catalogFile = (models: Record<string, unknown>): string => {
  dir ??= mkdtempSync(join(tmpdir(), "orosus-vg-"));
  const p = join(dir, "models-dev.json");
  writeFileSync(p, JSON.stringify({ fetchedAt: 1, catalog: { zai: { models } } }));
  return p;
};

const imgMsgs = (): ModelMessage[] => [
  { role: "user", content: [{ kind: "text", text: "看图" }, { kind: "image", path: "/m/a.png", mimeType: "image/png" }] },
  { role: "toolResult", callId: "c1", output: "o", isError: false, parts: [{ kind: "image", path: "/m/b.png", mimeType: "image/jpeg" }] },
];

describe("stripImageParts（纯函数——vision === false 时的剥除动作）", () => {
  it("user content 与 toolResult parts 的 image 全换文本占位（路径保留可再读）；无图消息原对象直返", () => {
    const msgs = imgMsgs();
    const out = stripImageParts(msgs);
    expect(out[0]).toEqual({ role: "user", content: [{ kind: "text", text: "看图" }, { kind: "text", text: nonVisionImagePlaceholder("/m/a.png") }] });
    expect(out[1]).toEqual({ role: "toolResult", callId: "c1", output: "o", isError: false, parts: [{ kind: "text", text: nonVisionImagePlaceholder("/m/b.png") }] });
    expect(out[0]).not.toBe(msgs[0]); // 新对象（不污染入参）
    expect(nonVisionImagePlaceholder("/m/a.png")).toContain("/model 换视觉模型"); // 指路文案先例形态
  });
});

describe("gateImagesByVision（F4 门控——false 拦 / true·undefined 放行）", () => {
  it("① 目录明确 false → 剥图占位（工具照跑、图不随请求发）", () => {
    const file = catalogFile({ "glm-text": { modalities: { input: ["text"] } } });
    const out = gateImagesByVision("glm-text", imgMsgs(), file);
    expect(JSON.stringify(out)).not.toContain('"kind":"image"');
    expect(JSON.stringify(out)).toContain("当前模型不支持图片输入");
  });

  it("② true（多模态）与 undefined（目录无此模型/自架）→ 原样放行（tui 批 F5 二轮⑭ 语义——自架 vision 不误伤）", () => {
    const file = catalogFile({ "glm-v": { modalities: { input: ["text", "image"] } }, "glm-text": { modalities: { input: ["text"] } } });
    const msgs = imgMsgs();
    expect(gateImagesByVision("glm-v", msgs, file)).toBe(msgs); // 原引用直返（零拷贝）
    expect(gateImagesByVision("my-selfhosted/vision-model", msgs, file)).toBe(msgs);
  });

  it("③ 无图请求零开销直返（不触目录读）；目录文件缺席 = undefined 放行", () => {
    const noImg: ModelMessage[] = [{ role: "user", content: [{ kind: "text", text: "纯文本" }] }];
    expect(gateImagesByVision("anything", noImg, "Z:/nope/catalog.json")).toBe(noImg);
    const msgs = imgMsgs();
    expect(gateImagesByVision("glm-text", msgs, "Z:/nope/catalog.json")).toBe(msgs); // 读不到 → undefined → 放行
  });
});

// 装配钉（§11 验收纪律）：门控接线在 stream 构造点——拿掉 gateImagesByVision 调用这两枚变红
describe("F4 门控 stream 接线（openai/anthropic 两族——目录明确 false 时线缆无图、占位可见）", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  const imgReq = (model: string, tmpFile: string): ProviderRequest => ({
    model, system: "", tools: [],
    messages: [
      { role: "user", content: [{ kind: "text", text: "看图" }, { kind: "image", path: tmpFile, mimeType: "image/png" }] },
      { role: "toolResult", callId: "c1", output: "o", isError: false, parts: [{ kind: "image", path: tmpFile, mimeType: "image/png" }] },
    ],
    signal: new AbortController().signal,
  });

  it("④ openai 族：非图模型 → 线缆零 image_url、占位文案在场（bridge flush 也不发）", async () => {
    dir ??= mkdtempSync(join(tmpdir(), "orosus-vg2-"));
    const img = join(dir, "a.png");
    writeFileSync(img, PNG);
    const file = catalogFile({ "text-m": { modalities: { input: ["text"] } } });
    const bodies: string[] = [];
    const ok = String.raw`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}` + "\n\n" + "data: [DONE]\n\n";
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(ok, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const { createStream } = await import("./stream-openai.ts");
    for await (const _ of createStream({ baseUrl: "https://x/v1", fetchImpl, catalogFile: file })(imgReq("text-m", img))) { /* drain */ }
    const wire = bodies[0]!;
    expect(wire).not.toContain("image_url");
    expect(wire).toContain("当前模型不支持图片输入");
    expect(wire).toContain("/model 换视觉模型");
  });

  it("⑤ anthropic 族：非图模型 → tool_result/user 全文本块（零 image source）", async () => {
    dir ??= mkdtempSync(join(tmpdir(), "orosus-vg3-"));
    const img = join(dir, "b.png");
    writeFileSync(img, PNG);
    const file = catalogFile({ "text-m": { modalities: { input: ["text"] } } });
    const bodies: string[] = [];
    const sse = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const { createStream } = await import("./stream-anthropic.ts");
    for await (const _ of createStream({ baseUrl: "https://x", fetchImpl, catalogFile: file })(imgReq("text-m", img))) { /* drain */ }
    const wire = bodies[0]!;
    expect(wire).not.toContain('"type":"image"');
    expect(wire).toContain("当前模型不支持图片输入");
  });
});
