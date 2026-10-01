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
