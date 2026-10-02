import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { createReadMediaFileTool } from "./readfile.ts";
import { sniffMime } from "./imaging.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-rmf-")));

const run = async (tool: ReturnType<typeof createReadMediaFileTool>, input: Record<string, unknown>) => {
  const planned = await tool.resolveExecution(input);
  return planned.execute({ callId: "c", signal: new AbortController().signal, log: { info() {}, warn() {}, error() {}, debug() {} } as never });
};

describe("ReadMediaFile（m5-media F10——投递四档 + F4 门控 + 卫戍）", () => {
  it("① untouched 档：达标小图 → 原图路径直交（images、零 rawImages 零拷贝）", async () => {
    const d = fresh();
    const p = join(d, "small.png");
    await new Jimp({ width: 400, height: 300, color: 0xff0000ff }).write(p as `${string}.png`);
    const r = await run(createReadMediaFileTool(), { path: p });
    expect(r.isError).toBe(false);
    expect(r.images).toEqual([{ path: p, mimeType: "image/png" }]);
    expect((r as { rawImages?: unknown }).rawImages).toBeUndefined();
    expect(r.output).toContain("原图投递");
  }, 30_000);

  it("② downsampled 档：3000² 大图 → rawImages 通道降采样副本（~1240²，token 绑）+ 投递说明", async () => {
    const d = fresh();
    const p = join(d, "big.png");
    await new Jimp({ width: 3000, height: 3000, color: 0x00ff00ff }).write(p as `${string}.png`);
    const r = await run(createReadMediaFileTool(), { path: p });
    expect(r.isError).toBe(false);
    expect((r as { images?: unknown }).images).toBeUndefined();
    const raw = (r as { rawImages?: { data: string; mimeType: string }[] }).rawImages;
    expect(raw).toHaveLength(1);
    expect(raw![0]!.mimeType).toBe("image/png");
    const dims = sniffMime(Buffer.from(raw![0]!.data, "base64")); // 有魔数即可解
    expect(dims).toBe("image/png");
    expect(r.output).toContain("降采样");
    expect(r.output).toContain("1238"); // √(2048×750)·1000/3000 ≈ 1239.3 → 偶数取整 1238
  }, 60_000);

  it("③ crop 档：region 裁剪 → rawImages 出裁剪副本（尺寸=裁剪区受边界夹紧）；full_resolution 无 region → 原图直交", async () => {
    const d = fresh();
    const p = join(d, "mid.png");
    await new Jimp({ width: 800, height: 600, color: 0x0000ffff }).write(p as `${string}.png`);
    const r = await run(createReadMediaFileTool(), { path: p, region: { x: 100, y: 50, width: 200, height: 100 } });
    expect(r.isError).toBe(false);
    const raw = (r as { rawImages?: { data: string }[] }).rawImages;
    expect(raw).toHaveLength(1);
    expect(r.output).toContain("(100,50,200,100)");
    const full = await run(createReadMediaFileTool(), { path: p, full_resolution: true });
    expect(full.images).toEqual([{ path: p, mimeType: "image/png" }]); // full 档跳预压
  }, 30_000);

  it("④ F4 门控：目录明确非视觉模型 → 工具照跑但拒发图、留路径指路；vision/未知模型放行", async () => {
    const d = fresh();
    const p = join(d, "a.png");
    await new Jimp({ width: 100, height: 100, color: 0xff00ffff }).write(p as `${string}.png`);
    const catalog = join(d, "models-dev.json");
    writeFileSync(catalog, JSON.stringify({ fetchedAt: 1, catalog: { zai: { models: { "text-m": { modalities: { input: ["text"] } }, "v-m": { modalities: { input: ["text", "image"] } } } } } }));
    const gated = await run(createReadMediaFileTool({ model: () => "text-m", catalogFile: catalog }), { path: p });
    expect(gated.isError).toBe(false); // 不是错误——是一档拒发+二档留据
    expect((gated as { images?: unknown }).images).toBeUndefined();
    expect(gated.output).toContain("不支持图片输入");
    expect(gated.output).toContain("/model");
    expect(gated.output).toContain(p); // 路径留据
    const vision = await run(createReadMediaFileTool({ model: () => "v-m", catalogFile: catalog }), { path: p });
    expect(vision.images).toHaveLength(1); // vision 放行
    const unknown = await run(createReadMediaFileTool({ model: () => "selfhosted/x", catalogFile: catalog }), { path: p });
    expect(unknown.images).toHaveLength(1); // 未知（自架）放行——tui 批 F5 二轮⑭ 语义
    // ④b 执行期现读（2026-10-02 readfile 门修复）：异步 getter（宿主 liveModel 形态）同样触发门——
    // 修复前快照式 getter 在首轮 turn 进行中为空、门静默放行原图（实机 11:31 白投案）
    const live = await run(createReadMediaFileTool({ model: async () => "text-m", catalogFile: catalog }), { path: p });
    expect((live as { images?: unknown }).images).toBeUndefined();
    expect(live.output).toContain("不支持图片输入");
  }, 30_000);

  it("⑤ 卫戍：文件缺失 / 非图格式 / 超 100MB 帽（按 stat 模拟不了大文件——以缺失与格式两档钉卫戍行为）", async () => {
    const missing = await run(createReadMediaFileTool(), { path: "Z:/nope/ghost.png" });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("读不到");
    const d = fresh();
    const txt = join(d, "note.txt");
    writeFileSync(txt, "不是图");
    const bad = await run(createReadMediaFileTool(), { path: txt });
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("无法识别的图片格式");
  });
});

describe("ReadMediaFile 视频三分支（m5-media F11——spike 实证直发/抽帧两路）", () => {
  const mp4Magic = Buffer.alloc(16);
  mp4Magic.writeUInt32BE(16, 0); // ftyp 盒长
  mp4Magic.write("ftyp", 4, "ascii");
  mp4Magic.write("isom", 8, "ascii");

  it("⑥ ① 直发：目录声明吃视频的模型 → videos 路径引用；未知模型同样直发（F4 三值语义）", async () => {
    const d = fresh();
    const p2 = join(d, "clip.mp4");
    writeFileSync(p2, mp4Magic);
    const catalog = join(d, "models-dev.json");
    writeFileSync(catalog, JSON.stringify({ fetchedAt: 1, catalog: { zai: { models: { "v-m": { modalities: { input: ["text", "image", "video"] } }, "img-only": { modalities: { input: ["text", "image"] } } } } } }));
    const direct = await run(createReadMediaFileTool({ model: () => "v-m", catalogFile: catalog }), { path: p2 });
    expect(direct.isError).toBe(false);
    expect(direct.videos).toEqual([{ path: p2, mimeType: "video/mp4" }]);
    expect(direct.output).toContain("直发");
    const unknown = await run(createReadMediaFileTool({ model: () => "selfhost/x", catalogFile: catalog }), { path: p2 });
    expect(unknown.videos).toHaveLength(1); // undefined 放行
    expect(unknown.output).toContain("未知");
  });

  it("⑦ ③ 抽帧：不吃视频的模型 + ffmpeg 在场 → 帧转图（rawImages，说明带帧数与档位）；④ 无 ffmpeg 诚实占位", async () => {
    const d = fresh();
    const { execFileSync } = await import("node:child_process");
    let hasFF = true;
    try { execFileSync("ffmpeg", ["-version"]); } catch { hasFF = false; }
    const catalog = join(d, "models-dev.json");
    writeFileSync(catalog, JSON.stringify({ fetchedAt: 1, catalog: { zai: { models: { "img-only": { modalities: { input: ["text", "image"] } } } } } }));
    if (hasFF) {
      const clip = join(d, "real.mp4");
      await new Promise<void>((resolve, reject) => {
        const { spawn } = require("node:child_process") as typeof import("node:child_process");
        const ff = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:size=160x120:duration=2", "-pix_fmt", "yuv420p", "-r", "10", clip]);
        ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))));
      });
      const r = await run(createReadMediaFileTool({ model: () => "img-only", catalogFile: catalog }), { path: clip, frames: 2 });
      expect(r.isError).toBe(false);
      const raw = (r as { rawImages?: unknown[] }).rawImages;
      expect(Array.isArray(raw)).toBe(true);
      expect(raw!.length).toBeGreaterThan(0);
      expect(r.output).toContain("抽");
      expect(r.output).toContain("帧");
    } else {
      // ④ 分支：假 mp4（魔数合法、内容不可解）+ 无 ffmpeg 机器——占位文案（本机有 ffmpeg 时以注入法验证同分支）
      const fakeMp4 = join(d, "fake.mp4");
      const bad = Buffer.alloc(64);
      bad.writeUInt32BE(16, 0); bad.write("ftyp", 4, "ascii"); bad.write("isom", 8, "ascii");
      writeFileSync(fakeMp4, bad);
      const r = await run(createReadMediaFileTool({ model: () => "img-only", catalogFile: catalog }), { path: fakeMp4 });
      expect(r.output).toContain("抽帧失败"); // ffmpeg 在但内容不可解 → 带内错误回落（占位语义同源）
    }
  }, 60_000);
});

// F10×D12：主模型非视觉但视觉模型已配 → 读图改为眼睛转述（摘要文本进对话）
describe("ReadMediaFile 眼睛转述（F10×D12）", () => {
  it("⑥b 非视觉模型 + summarize 可用 → 转述文本 + 原图路径；summarize 失败/缺席 → 回落路径指路", async () => {
    const d = fresh();
    const p2 = join(d, "e.png");
    await new Jimp({ width: 60, height: 40, color: 0x00ffff }).write(p2 as `${string}.png`);
    const catalog = join(d, "models-dev.json");
    writeFileSync(catalog, JSON.stringify({ fetchedAt: 1, catalog: { zai: { models: { "text-m": { modalities: { input: ["text"] } } } } } }));
    const r = await run(createReadMediaFileTool({ model: () => "text-m", catalogFile: catalog, summarize: async () => "绿色矩形图表，左上角有标题" }), { path: p2 });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("视觉模型转述");
    expect(r.output).toContain("绿色矩形图表");
    expect(r.output).toContain(p2); // 原图路径留据
    expect((r as { images?: unknown }).images).toBeUndefined(); // 不投图——主模型吃不了
    const fell = await run(createReadMediaFileTool({ model: () => "text-m", catalogFile: catalog, summarize: async () => undefined }), { path: p2 });
    expect(fell.output).toContain("/model 换视觉模型"); // 回落路径指路
    const noEye = await run(createReadMediaFileTool({ model: () => "text-m", catalogFile: catalog }), { path: p2 });
    expect(noEye.output).toContain("/model 换视觉模型"); // 未配 summarize 同回落
  }, 30_000);
});
