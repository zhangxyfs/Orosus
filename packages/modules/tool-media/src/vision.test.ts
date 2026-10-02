import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import { Jimp } from "jimp";
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

  it("③ 失败/空产出 → undefined 回落纯标签；error finish 不缓存；onFail 带原因（诊断批——修复前只落路径不落因）", async () => {
    const d = fresh();
    const img = join(d, "bad.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    const fails: string[] = [];
    const errDeps = { llmStream: () => fakeStream([{ type: "finish", kind: "error", errorMessage: "boom" }])(), onFail: (r: string) => fails.push(r), retryBackoffMs: [] };
    expect(await summarizeImage(img, "image/png", "eye/m", errDeps as never)).toBeUndefined();
    expect(readSummary(img)).toBeUndefined(); // 不缓存失败
    expect(fails).toEqual(["boom"]); // 原因带出（不再吞）
    const emptyDeps = { llmStream: () => fakeStream([{ type: "finish", kind: "stop" }])(), retryBackoffMs: [] };
    expect(await summarizeImage(img, "image/png", "eye/m", emptyDeps as never)).toBeUndefined();
  });

  it("③b 进行中去重（2026-10-02 拍板）：同一图并发调用共享同一次流（双 Esc 中止后秒内重发的小窗口不双花）；落盘后新调用走缓存", async () => {
    const d = fresh();
    const img = join(d, "dup.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowDeps = {
      llmStream: () => {
        calls++;
        return (async function* (): AsyncIterable<Chunk> {
          await gate; // 悬住首次调用——并发窗口打开
          yield { type: "text/delta", text: "共享一次调用的描述" };
          yield { type: "finish", kind: "stop" };
        })();
      },
      retryBackoffMs: [],
    };
    const p1 = summarizeImage(img, "image/png", "eye/m", slowDeps as never);
    const p2 = summarizeImage(img, "image/png", "eye/m", slowDeps as never); // 首次未完——进行中命中
    release();
    expect(await p1).toContain("共享一次调用");
    expect(await p2).toBe(await p1);
    expect(calls).toBe(1); // 只发一次视觉请求
    expect(await summarizeImage(img, "image/png", "eye/m", slowDeps as never)).toContain("共享一次调用");
    expect(calls).toBe(1); // 已落缓存——第三次仍零请求
  });

  it("③c 瞬时故障重试（诊断批）：两次带内错误后第三次成功——共 3 次请求；onFail 带原因与退避标注", async () => {
    const d = fresh();
    const img = join(d, "retry.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    let calls = 0;
    const fails: string[] = [];
    const deps = {
      llmStream: () => {
        calls++;
        return calls < 3
          ? fakeStream([{ type: "finish", kind: "error", errorMessage: "fetch failed: ECONNRESET" }])()
          : fakeStream([{ type: "text/delta", text: "第三次成功" }, { type: "finish", kind: "stop" }])();
      },
      onFail: (r: string) => fails.push(r),
      retryBackoffMs: [1, 1],
    };
    expect(await summarizeImage(img, "image/png", "eye/m", deps as never)).toContain("第三次成功");
    expect(calls).toBe(3);
    expect(fails).toHaveLength(2);
    expect(fails[0]).toContain("ECONNRESET");
    expect(fails[0]).toContain("重试");
    expect(readSummary(img)).toContain("第三次成功"); // 成功后照常落缓存
  });

  it("③c-b 鉴权类不重试：401 一次即弃（重试白花）；onFail 原因不带退避标注", async () => {
    const d = fresh();
    const img = join(d, "auth.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    let calls = 0;
    const fails: string[] = [];
    const deps = {
      llmStream: () => { calls++; return fakeStream([{ type: "finish", kind: "error", errorMessage: "HTTP 401: invalid api key" }])(); },
      onFail: (r: string) => fails.push(r),
      retryBackoffMs: [1, 1],
    };
    expect(await summarizeImage(img, "image/png", "eye/m", deps as never)).toBeUndefined();
    expect(calls).toBe(1); // 不重试
    expect(fails).toEqual(["HTTP 401: invalid api key"]);
  });

  it("③d 转述前预降采样（拍板「再改功能」）：大图请求走 .eye. 降采样副本（缓存仍键原图）；小图 unchanged 直用原路径", async () => {
    const d = fresh();
    const seen: { path?: string }[] = [];
    const deps = {
      llmStream: (req: { messages: { content: ({ kind: string; path?: string })[] }[] }) => {
        seen.push(req.messages[0]!.content.find((p) => p.kind === "image") as { path?: string });
        return fakeStream([{ type: "text/delta", text: "红底方块" }, { type: "finish", kind: "stop" }])();
      },
    };
    const big = join(d, "big.png");
    await new Jimp({ width: 3000, height: 3000, color: 0xff0000ff }).write(big as `${string}.png`);
    const out = await summarizeImage(big, "image/png", "eye/m", deps as never);
    expect(out).toContain("红底方块");
    expect(seen[0]!.path).toContain(".eye."); // 3000px → tier 1024 降采样副本（≈1568 边）
    expect(seen[0]!.path).not.toBe(big);
    expect(readSummary(big)).toBe(out); // 缓存键 = 原图路径（副本只是请求形态）
    const small = join(d, "small.png");
    await new Jimp({ width: 100, height: 100, color: 0x00ffffff }).write(small as `${string}.png`);
    await summarizeImage(small, "image/png", "eye/m", deps as never);
    expect(seen[1]!.path).toBe(small); // 小图零拷贝直用原路径
  });

  it("③e 全量转述提示词（2026-10-02 用户拍板「太不细致」）：要求逐条原样转录+颜色/线条；产出按 1200 帽截断（旧 500 不再拦腰）", async () => {
    const d = fresh();
    const img = join(d, "full.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    let prompt = "";
    let maxTokens = 0;
    const deps = {
      llmStream: (req: { messages?: { content?: { text?: string }[] }[]; maxTokens?: number }) => {
        prompt = String(req.messages?.[0]?.content?.[0]?.text ?? "");
        maxTokens = Number(req.maxTokens ?? 0);
        return fakeStream([{ type: "text/delta", text: "字".repeat(2000) }, { type: "finish", kind: "stop" }])();
      },
      retryBackoffMs: [],
    };
    const out = await summarizeImage(img, "image/png", "eye/m", deps as never);
    expect(out).toHaveLength(2000); // 帽 2000（内容复杂度推高生成侧——用户点破 1200 不够密文截图）
    expect(prompt).toContain("逐条原样转录"); // 可见文字原样转录（不概括）——用户点名要的细致度
    expect(prompt).toContain("颜色");
    expect(prompt).toContain("线条");
    expect(maxTokens).toBeGreaterThanOrEqual(2000); // 帽够得着（旧 300 出半截）
  });

  it("③f 转述思考档（卡 23s 空产出修）：目录声明 low → 请求带 reasoningEffort=low；无声明 → 不带字段（lenient 照发会 400 自证）", async () => {
    const d = fresh();
    const img = join(d, "eff.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    const cat = join(d, "models-dev.json");
    writeFileSync(cat, JSON.stringify({ catalog: { zai: { models: { "eye/m": { id: "eye/m", reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] } } } } }));
    const efforts: (string | undefined)[] = [];
    const deps = {
      llmStream: (req: { reasoningEffort?: string }) => {
        efforts.push(req.reasoningEffort);
        return fakeStream([{ type: "text/delta", text: "低思考快出" }, { type: "finish", kind: "stop" }])();
      },
      catalogFile: cat,
      retryBackoffMs: [],
    };
    expect(await summarizeImage(img, "image/png", "eye/m", deps as never)).toContain("低思考快出");
    expect(efforts[0]).toBe("low"); // 目录声明 low 在列——降档发出
    writeFileSync(cat, JSON.stringify({ catalog: { zai: { models: { "eye/m": { id: "eye/m" } } } } })); // 无声明
    const img2 = join(d, "eff2.png");
    writeFileSync(img2, Buffer.from([0x89, 0x50]));
    expect(await summarizeImage(img2, "image/png", "eye/m", deps as never)).toContain("低思考快出");
    expect(efforts[1]).toBeUndefined(); // 无声明不带字段
  });

  it("③g 流式增量透传（A 案）：onDelta 逐 chunk 上抛思考/正文（kind 与顺序保持）；maxTokens 2000（思考余量保险）", async () => {
    const d = fresh();
    const img = join(d, "stream.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    const deltas: { kind: string; text: string }[] = [];
    let maxTokens = 0;
    const deps = {
      llmStream: (req: { maxTokens?: number }) => {
        maxTokens = Number(req.maxTokens ?? 0);
        return fakeStream([
          { type: "reasoning/delta", text: "先想一想" },
          { type: "text/delta", text: "正文开始" },
          { type: "text/delta", text: "，继续" },
          { type: "finish", kind: "stop" },
        ] as Chunk[])();
      },
      onDelta: (d: { kind: string; text: string }) => deltas.push(d),
      retryBackoffMs: [],
    };
    expect(await summarizeImage(img, "image/png", "eye/m", deps as never)).toContain("正文开始，继续");
    expect(deltas).toEqual([
      { kind: "thinking", text: "先想一想" },
      { kind: "text", text: "正文开始" },
      { kind: "text", text: "，继续" },
    ]);
    expect(maxTokens).toBe(6000); // 生成帽天花板（图繁→转录+思考都长——2000 会截断密文截图；上限不花钱）
  });

  it("③h 长度帽截断带内信号：finish/length → 正文照收 + 尾部标注（图内容更繁的诚实信号——非失败不重试）", async () => {
    const d = fresh();
    const img = join(d, "trunc.png");
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    const deps = { llmStream: () => fakeStream([{ type: "text/delta", text: "前半段转录" }, { type: "finish", kind: "length" }])(), retryBackoffMs: [] };
    const out = await summarizeImage(img, "image/png", "eye/m", deps as never);
    expect(out).toContain("前半段转录"); // 截断非失败——半份转录好过没有
    expect(out).toContain("长度帽截断"); // 尾部标注进缓存与占位（模型与用户都知情）
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
