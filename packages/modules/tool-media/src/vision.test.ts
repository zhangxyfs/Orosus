import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import { readSummary, resolveEyeModel, summaryPathOf, summarizeImage } from "./vision.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-vis-")));

describe("resolveEyeModel（D12 三态）", () => {
  it("① off=不生成；auto=当前模型 vision 直用/非 vision 诚实回落（跨槽挑需 provider 配置不可达）；指定=原值", () => {
    expect(resolveEyeModel("off", "any/m", () => true).model).toBeUndefined();
    expect(resolveEyeModel("auto", "glm-5.3-flash", () => true).model).toBe("glm-5.3-flash"); // 直用
    expect(resolveEyeModel("auto", "text-m", () => false).model).toBeUndefined(); // 回落+note
    expect(resolveEyeModel("auto", "text-m", () => false).note).toContain("回落");
    expect(resolveEyeModel("auto", undefined, () => true).model).toBeUndefined(); // 拿不到当前模型
    expect(resolveEyeModel("zhipuai-coding-plan/glm-5.3-flash", "x/y", () => false).model).toBe("zhipuai-coding-plan/glm-5.3-flash"); // 指定
  });
});

describe("summarizeImage（F13——后台生成 + 缓存 + 失败回落）", () => {
  const fakeStream = (chunks: Chunk[]) => async function* (): AsyncIterable<Chunk> { for (const c of chunks) yield c; };

  it("② 成功生成 → 缓存文件落盘（<名>.summary.txt）→ 二次调用命中缓存零请求；末条显式 user 指令形态", async () => {
    const d = fresh();
    const img = join(d, "shot.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    let calls = 0;
    const deps = {
      llmStream: (req: { messages: { role: string; content: unknown[] }[] }) => {
        calls++;
        expect(req.messages.at(-1)!.role).toBe("user"); // 末条 user 指令（compaction v3 坑纪律）
        return fakeStream([{ type: "text/delta", text: "登录页，" }, { type: "text/delta", text: "含蓝色提交按钮" }, { type: "finish", kind: "stop" }])();
      },
    };
    const out = await summarizeImage(img, "image/png", "eye/m", deps as never);
    expect(out).toContain("登录页");
    expect(readSummary(img)).toBe(out);
    expect(summaryPathOf(img)).toBe(`${img}.summary.txt`);
    const again = await summarizeImage(img, "image/png", "eye/m", deps as never);
    expect(again).toBe(out);
    expect(calls).toBe(1); // 缓存命中——零二次请求
  });

  it("③ 失败/空产出 → undefined 回落纯标签；error finish 不缓存", async () => {
    const d = fresh();
    const img = join(d, "bad.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    const errDeps = { llmStream: () => fakeStream([{ type: "finish", kind: "error", errorMessage: "boom" }])() };
    expect(await summarizeImage(img, "image/png", "eye/m", errDeps as never)).toBeUndefined();
    expect(readSummary(img)).toBeUndefined(); // 不缓存失败
    const emptyDeps = { llmStream: () => fakeStream([{ type: "finish", kind: "stop" }])() };
    expect(await summarizeImage(img, "image/png", "eye/m", emptyDeps as never)).toBeUndefined();
  });
});

describe("降级/压缩标签富化（F13 消费侧——缓存同步读）", () => {
  it("④ mediabudget 降级标签带 [视觉摘要]；无缓存纯标签（走 provider-custom 侧单测同口径——此处钉缓存读取约定）", async () => {
    const d = fresh();
    const img = join(d, "x.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    writeFileSync(summaryPathOf(img), "红色矩形截图");
    expect(readSummary(img)).toBe("红色矩形截图");
    rmSync(summaryPathOf(img));
    expect(readSummary(img)).toBeUndefined();
  });
});
