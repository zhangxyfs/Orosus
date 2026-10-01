import { describe, it, expect, afterEach } from "vitest";
import { mapSseChunk, type OaiStreamState } from "./translate-openai.ts";

const state = (): OaiStreamState => ({ calls: new Map() });

describe("mapSseChunk usage 提取（/usage 走查：GLM 方言 usage 与 finish 同帧，此前被丢）", () => {
  it("① GLM/DeepSeek 方言：最后一帧 choices(finish) + usage 同帧 → usage 不丢、追加在 finish 之后", () => {
    const out = mapSseChunk(state(), {
      choices: [{ finish_reason: "stop", delta: {} }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });
    expect(out).toEqual([
      { type: "finish", kind: "stop" },
      { type: "usage", input: 12, output: 34 },
    ]);
  });

  it("② OpenAI 官方方言：空 choices 尾包 usage → 仅 usage chunk（回归）", () => {
    expect(mapSseChunk(state(), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } }))
      .toEqual([{ type: "usage", input: 3, output: 5 }]);
  });

  it("③ include_usage 中间帧 usage:null + 正常 choices → 不产 usage chunk、正文不受扰", () => {
    const out = mapSseChunk(state(), {
      choices: [{ delta: { content: "hi" } }],
      usage: null,
    });
    expect(out).toEqual([{ type: "text/delta", text: "hi" }]);
  });

  it("④ 正文与 usage 同帧：text/delta 在前、usage 收尾", () => {
    const out = mapSseChunk(state(), {
      choices: [{ delta: { content: "答" }, finish_reason: null }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    expect(out).toEqual([
      { type: "text/delta", text: "答" },
      { type: "usage", input: 1, output: 2 },
    ]);
  });
});

// MP-03 回归（报告条目：网关在已 200 的 SSE 流里推 data: {"error":{…}} 错误帧——无 choices 无 usage
// 落返 [] 被静默吞，流结束兜底 stop 把截断回复冒充完整）
describe("mapSseChunk 错误帧（MP-03：{\"error\":…} 帧 → finish{kind:\"error\"} 带内终局）", () => {
  it("⑤ 错误帧 → finish error；message 优先，code/type 递补，空对象给兜底文案", () => {
    expect(mapSseChunk(state(), { error: { message: "quota exceeded", code: 429 } }))
      .toEqual([{ type: "finish", kind: "error", errorMessage: "流错误：quota exceeded" }]);
    expect(mapSseChunk(state(), { error: { code: 429 } }))
      .toEqual([{ type: "finish", kind: "error", errorMessage: "流错误：code 429" }]);
    expect(mapSseChunk(state(), { error: { type: "insufficient_quota" } }))
      .toEqual([{ type: "finish", kind: "error", errorMessage: "流错误：insufficient_quota" }]);
    expect(mapSseChunk(state(), { error: {} }))
      .toEqual([{ type: "finish", kind: "error", errorMessage: "流错误：网关错误帧" }]);
  });

  it("⑥ error:null 方言不受扰（include_usage 中间帧同形）——正常 choices 照常映射（回归）", () => {
    expect(mapSseChunk(state(), { choices: [{ delta: { content: "hi" } }], error: null }))
      .toEqual([{ type: "text/delta", text: "hi" }]);
  });
});

// M4-2.5 T5：图片映射（ContentPart image 引用形态——日志存路径、请求期转 base64）
const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { toOpenAIMessages } = await import("./translate-openai.ts");
type MP = import("@orosus/contracts/provider").ModelMessage;

describe("toOpenAIMessages 图片映射（M4-2.5 T5）", () => {
  let imgDir: string | undefined;
  const pngPath = (): string => {
    imgDir ??= mkdtempSync(join(tmpdir(), "orosus-t5a-"));
    const p = join(imgDir, "shot.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    return p;
  };
  afterEach(() => { if (imgDir) { rmSync(imgDir, { recursive: true, force: true }); imgDir = undefined; } });
  const imgMsg = (path: string): MP => ({ role: "user", content: [{ kind: "text", text: "这是什么" }, { kind: "image", path, mimeType: "image/png" }] });

  it("① 含 image 的 user 消息 → content 数组形态（text type + image_url data URL）", () => {
    const p = pngPath();
    const out = toOpenAIMessages("", [imgMsg(p)]) as Array<{ role: string; content: unknown }>;
    expect(Array.isArray(out[0]!.content)).toBe(true);
    const parts = out[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: "text", text: "这是什么" });
    expect(parts[1]!.type).toBe("image_url");
    expect(parts[1]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(parts[1]!.image_url!.url.endsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"))).toBe(true);
  });

  it("② 纯文本消息 → 仍字符串（端点兼容最稳，回归钉）", () => {
    const out = toOpenAIMessages("", [{ role: "user", content: [{ kind: "text", text: "纯文本" }] }]) as Array<{ content: unknown }>;
    expect(out[0]!.content).toBe("纯文本");
  });

  it("③ 图片文件缺失 → 降级 text part 含「图片文件缺失」（不发坏请求）", () => {
    const out = toOpenAIMessages("", [imgMsg("Z:/nope/ghost.png")]) as Array<{ content: Array<{ type: string; text?: string }> }>;
    expect(out[0]!.content[1]!.type).toBe("text");
    expect(out[0]!.content[1]!.text).toContain("图片文件缺失");
    expect(out[0]!.content[1]!.text).toContain("ghost.png");
  });

  it("④ 多图+文本混合顺序保持", () => {
    const p1 = pngPath();
    const p2 = join(imgDir!, "second.png");
    writeFileSync(p2, "xx");
    const msg: MP = { role: "user", content: [
      { kind: "text", text: "两图" },
      { kind: "image", path: p1, mimeType: "image/png" },
      { kind: "image", path: p2, mimeType: "image/png" },
    ] };
    const out = toOpenAIMessages("", [msg]) as Array<{ content: Array<{ type: string }> }>;
    expect(out[0]!.content.map((x) => x.type)).toEqual(["text", "image_url", "image_url"]);
  });
});


// m5-media F3：工具结果带图三态（T0 spike 2026-10-01 三形态在 glm-5.3-flash 实证；bridge=默认）
describe("toOpenAIMessages 工具结果带图三态（m5-media F3）", () => {
  let f3Dir: string | undefined;
  afterEach(() => { if (f3Dir) { rmSync(f3Dir, { recursive: true, force: true }); f3Dir = undefined; } });
  const pngPath = (): string => {
    f3Dir ??= mkdtempSync(join(tmpdir(), "orosus-m5f3-"));
    const p = join(f3Dir, "shot.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    return p;
  };
  const shotMsg = (path: string, output = "截图完成"): MP => ({
    role: "toolResult", callId: "c1", output, isError: false,
    parts: [{ kind: "image", path, mimeType: "image/png" }],
  });

  it("① bridge（默认）：tool 消息纯文本 + 图 flush 成紧跟的只含图 user 消息", () => {
    const p = pngPath();
    const out = toOpenAIMessages("", [shotMsg(p)]) as Array<{ role: string; tool_call_id?: string; content: unknown }>;
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "tool", tool_call_id: "c1", content: "截图完成" });
    const flush = out[1]!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(out[1]!.role).toBe("user");
    expect(flush).toHaveLength(1);
    expect(flush[0]!.type).toBe("image_url");
    expect(flush[0]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("② bridge 连续 toolResult 聚合一次冲刷（消息最少）；缺失文件降级占位进 flush；无图结果零差异", () => {
    const p = pngPath();
    const noImg: MP = { role: "toolResult", callId: "c0", output: "纯文本", isError: false };
    const missing: MP = {
      role: "toolResult", callId: "c2", output: "o2", isError: false,
      parts: [{ kind: "image", path: "Z:/nope/ghost.png", mimeType: "image/png" }],
    };
    const out = toOpenAIMessages("", [noImg, shotMsg(p, "o1"), missing]) as Array<{ role: string; content: unknown }>;
    expect(out.map((m) => m.role)).toEqual(["tool", "tool", "tool", "user"]); // 三 tool + 一条聚合 flush
    const flush = out[3]!.content as Array<{ type: string; text?: string }>;
    expect(flush.map((x) => x.type)).toEqual(["image_url", "text"]); // 好图 + 缺失占位（诚实可见）
    expect(flush[1]!.text).toContain("图片文件缺失");
    // 无图零差异：不产 flush 消息
    const plain = toOpenAIMessages("", [noImg]) as unknown[];
    expect(plain).toHaveLength(1);
  });

  it("③ inline：tool 消息 content 部件数组（text + image_url——kimi keep_parts 形态）", () => {
    const p = pngPath();
    const out = toOpenAIMessages("", [shotMsg(p)], "inline") as Array<{ role: string; content: unknown }>;
    expect(out).toHaveLength(1);
    const parts = out[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.map((x) => x.type)).toEqual(["text", "image_url"]);
    expect(parts[0]!.text).toBe("截图完成");
    expect(parts[1]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("④ placeholder：图不送、文字占位（kimi 通用 openai 做法）；无任何 image_url 部件", () => {
    const p = pngPath();
    const out = toOpenAIMessages("", [shotMsg(p, "o")], "placeholder") as Array<{ role: string; content: unknown }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe(`o\n[图片 ${p} 未随请求发送——本端点工具消息不支持图片]`);
    expect(JSON.stringify(out)).not.toContain("image_url");
  });
});

// m5-media F11：视频部件线缆映射（spike 实证 glm-5.3-flash 吃 data URL video_url）
describe("toOpenAIMessages 视频部件（m5-media F11 路①）", () => {
  let vDir: string | undefined;
  const mp4Path = (): string => {
    vDir ??= mkdtempSync(join(tmpdir(), "orosus-m5f11-"));
    const p = join(vDir, "clip.mp4");
    const b = Buffer.alloc(32);
    b.writeUInt32BE(16, 0); b.write("ftypisom", 4, "ascii");
    writeFileSync(p, b);
    return p;
  };
  afterEach(() => { if (vDir) { rmSync(vDir, { recursive: true, force: true }); vDir = undefined; } });

  it("⑧ user 消息 video part → video_url data URL；toolResult video → bridge flush 同发；缺失文件降级占位", () => {
    const p = mp4Path();
    const msg: MP = { role: "user", content: [{ kind: "text", text: "看视频" }, { kind: "video", path: p, mimeType: "video/mp4" }] };
    const out = toOpenAIMessages("", [msg]) as Array<{ content: unknown }>;
    const parts = out[0]!.content as Array<{ type: string; video_url?: { url: string } }>;
    expect(parts[1]!.type).toBe("video_url");
    expect(parts[1]!.video_url!.url.startsWith("data:video/mp4;base64,")).toBe(true);
    // toolResult video → bridge flush（紧跟只含 video_url 的 user 消息）
    const tr: MP = { role: "toolResult", callId: "c1", output: "录好了", isError: false, parts: [{ kind: "video", path: p, mimeType: "video/mp4" }] };
    const out2 = toOpenAIMessages("", [tr]) as Array<{ role: string; content: unknown }>;
    expect(out2.map((m) => m.role)).toEqual(["tool", "user"]);
    const flush = out2[1]!.content as Array<{ type: string }>;
    expect(flush[0]!.type).toBe("video_url");
    // 缺失
    const ghost: MP = { role: "user", content: [{ kind: "video", path: "Z:/nope/x.mp4", mimeType: "video/mp4" }] };
    const out3 = toOpenAIMessages("", [ghost]) as Array<{ content: Array<{ type: string; text?: string }> }>;
    expect(out3[0]!.content[0]!.text).toContain("视频文件缺失");
  });
});
