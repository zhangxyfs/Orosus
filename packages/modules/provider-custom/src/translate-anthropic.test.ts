import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAnthropicMessages } from "./translate-anthropic.ts";
import type { ModelMessage } from "@orosus/contracts/provider";

// M4-2.5 T5 新建（现状无此文件——与 translate-openai.test.ts 先例对称）
describe("toAnthropicMessages 图片映射（M4-2.5 T5——base64 source block）", () => {
  let imgDir: string | undefined;
  const pngPath = (): string => {
    imgDir ??= mkdtempSync(join(tmpdir(), "orosus-t5b-"));
    const p = join(imgDir, "shot.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    return p;
  };
  afterEach(() => { if (imgDir) { rmSync(imgDir, { recursive: true, force: true }); imgDir = undefined; } });

  it("⑤ image part → base64 source block（media_type + data）", () => {
    const p = pngPath();
    const msg: ModelMessage = { role: "user", content: [{ kind: "text", text: "看图" }, { kind: "image", path: p, mimeType: "image/png" }] };
    const out = toAnthropicMessages([msg]) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(out[0]!.content[0]).toEqual({ type: "text", text: "看图" });
    const img = out[0]!.content[1]!;
    expect(img["type"]).toBe("image");
    const src = img["source"] as { type: string; media_type: string; data: string };
    expect(src.type).toBe("base64");
    expect(src.media_type).toBe("image/png");
    expect(src.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"));
  });

  it("⑥ 图片文件缺失 → 降级 text block 含「图片文件缺失」", () => {
    const msg: ModelMessage = { role: "user", content: [{ kind: "image", path: "Z:/nope/ghost.png", mimeType: "image/png" }] };
    const out = toAnthropicMessages([msg]) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(out[0]!.content[0]!["type"]).toBe("text");
    expect(String(out[0]!.content[0]!["text"])).toContain("图片文件缺失");
  });
});
