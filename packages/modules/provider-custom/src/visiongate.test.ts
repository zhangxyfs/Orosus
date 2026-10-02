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
    expect(nonVisionImagePlaceholder("/m/a.png")).toContain("图片未随消息送达"); // 事实占位（2026-10-02 复盘：不放 /model 建议——模型会当传声筒复述）
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
    expect(wire).toContain("图片未随消息送达"); // 事实占位不放行动建议（传声筒复盘）
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

// F13/F14 扩面：非视觉占位带眼睛摘要缓存（发送闸旁路后——非视觉主模型照样「读懂」图）
describe("nonVisionImagePlaceholder 摘要富化（F13/F14 扩面）", () => {
  it("⑥ 同名 .summary.txt 在场 → 描述优先占位；无缓存/空文件 → 纯事实占位", () => {
    const { mkdtempSync, writeFileSync, rmSync } = await0();
    const d = mkdtempSync(join(tmpdir(), "orosus-vg3-"));
    try {
      const img = join(d, "p.png");
      writeFileSync(img, Buffer.alloc(4));
      const plain = nonVisionImagePlaceholder(img);
      expect(plain).toContain("不支持图片输入");
      expect(plain).not.toContain("图片描述"); // 无缓存 = 不摆描述壳
      expect(plain).not.toContain("/model"); // 事实占位不放行动建议（传声筒复盘——模型可见文本只陈述）
      writeFileSync(`${img}.summary.txt`, "蓝色按钮的登录页");
      const rich = nonVisionImagePlaceholder(img);
      expect(rich).toContain("蓝色按钮的登录页"); // 描述优先——非视觉主模型「读懂」图
      expect(rich).toContain("视觉模型转述");
      expect(rich).toContain("不可信"); // 注入防御头（Reasonix untrusted 同款）
      expect(rich).toContain(img); // 路径留据
      writeFileSync(`${img}.summary.txt`, "[summary-v3]\n带版本标记的描述"); // 新格式：首行版本标记
      const marked = nonVisionImagePlaceholder(img);
      expect(marked).toContain("带版本标记的描述"); // 标记被剥——正文直出
      expect(marked).not.toContain("summary-v3"); // 标记不漏进占位文本
      writeFileSync(`${img}.summary.txt`, "   ");
      expect(nonVisionImagePlaceholder(img)).not.toContain("蓝色按钮"); // 空白文件 = 无摘要
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// mkdtemp 等的零参占位（顶部 import 已有 mkdtempSync/writeFileSync/rmSync/join/tmpdir——await0 防误用）
function await0(): { mkdtempSync: typeof import("node:fs").mkdtempSync; writeFileSync: typeof import("node:fs").writeFileSync; rmSync: typeof import("node:fs").rmSync } {
  return { mkdtempSync, writeFileSync, rmSync };
}
