import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapEvent, thinkingParamFor, toAnthropicMessages, type SseState } from "./translate-anthropic.ts";
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

// MP-02 回归（报告条目：on/未知档裸 {type:"enabled"} 违反官方约束——budget_tokens 必填且须小于 max_tokens）
describe("thinkingParamFor（MP-02：enabled 恒钉 budget_tokens——官方必填，裸发即 400）", () => {
  it("① off/none → disabled；low/medium/high → 1024/4096/32000", () => {
    expect(thinkingParamFor("off")).toEqual({ type: "disabled" });
    expect(thinkingParamFor("none")).toEqual({ type: "disabled" });
    expect(thinkingParamFor("low")).toEqual({ type: "enabled", budget_tokens: 1024 }); // 官方下限 1024
    expect(thinkingParamFor("medium")).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(thinkingParamFor("high")).toEqual({ type: "enabled", budget_tokens: 32_000 });
  });

  it("② on 与未知档名（max/xhigh/minimal…）→ 高档安全预算 32000，不裸发 enabled；大小写不敏感", () => {
    expect(thinkingParamFor("on")).toEqual({ type: "enabled", budget_tokens: 32_000 }); // kimi-code 'on' 同款
    expect(thinkingParamFor("max")).toEqual({ type: "enabled", budget_tokens: 32_000 });
    expect(thinkingParamFor("MINIMAL")).toEqual({ type: "enabled", budget_tokens: 32_000 });
  });
});

// MP-03 回归（报告条目：switch 无 error 分支、default 返 []——SSE 流内 error 事件被静默吞，
// 服务端随即关流无 message_stop，loop 缺省补 stop，半截回复冒充完整答复）
describe("mapEvent 流内 error 事件（MP-03：error 事件 → finish{kind:\"error\"} 带内终局）", () => {
  const st = (): SseState => ({ inputTokens: 0, currentCall: null, pendingStop: null });

  it("① 官方形态：event:error + error.type/message → finish error（对照 loop finish kind 语义）", () => {
    expect(mapEvent(st(), "error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }))
      .toEqual([{ type: "finish", kind: "error", errorMessage: "overloaded_error：Overloaded" }]);
  });

  it("② 无 event: 行的方言（parseSseBlock 默认 message）data.type=error 同样终局；残缺载荷给兜底文案", () => {
    expect(mapEvent(st(), "message", { type: "error", error: { type: "overloaded_error" } }))
      .toEqual([{ type: "finish", kind: "error", errorMessage: "overloaded_error：服务端流内错误" }]);
    expect(mapEvent(st(), "error", { type: "error" }))
      .toEqual([{ type: "finish", kind: "error", errorMessage: "error：服务端流内错误" }]);
  });

  it("③ ping 等其余未知事件仍忽略（回归——不被 error 分支误伤）", () => {
    expect(mapEvent(st(), "ping", { type: "ping" })).toEqual([]);
  });
});
