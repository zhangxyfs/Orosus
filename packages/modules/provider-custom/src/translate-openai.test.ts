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
