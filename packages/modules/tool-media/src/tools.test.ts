import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Jimp } from "jimp";
import { createConvertTool, createCropTool, createDownsampleTool, createVideoClipTool, runMediaTool } from "./tools.ts";
import { sniffMime } from "./imaging.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-mtools-")));

const hasFF = (() => { try { execFileSync("ffmpeg", ["-version"]); return true; } catch { return false; } })();

describe("媒体工具族（m5-media F12——qwen omni 式模型可调）", () => {
  it("① media_downsample：3000² 大图 → 1024 档缩（~866²）rawImages 副本；已达档小图 → 原图路径直交零副本", async () => {
    const d = fresh();
    const big = join(d, "big.png");
    await new Jimp({ width: 3000, height: 3000, color: 0xff0000ff }).write(big as `${string}.png`);
    const r = await runMediaTool(createDownsampleTool(), { path: big, token_tier: 1024 });
    expect(r.isError).toBe(false);
    const raw = (r as { rawImages?: { data: string; mimeType: string }[] }).rawImages;
    expect(raw).toHaveLength(1);
    expect(raw![0]!.mimeType).toBe("image/png");
    expect(r.output).toContain("876×876"); // √(1024×750)=876.4 → 3000² 缩到 876²
    const small = join(d, "s.png");
    await new Jimp({ width: 100, height: 100, color: 0x00ffffff }).write(small as `${string}.png`);
    const r2 = await runMediaTool(createDownsampleTool(), { path: small, token_tier: 2048 });
    expect(r2.images).toEqual([{ path: small, mimeType: "image/png" }]);
    expect(r2.output).toContain("无需降采样");
  }, 60_000);

  it("② media_crop：region 裁剪 → rawImages（尺寸=裁剪区、2048 档不缩）；越界夹紧不炸", async () => {
    const d = fresh();
    const src = join(d, "src.png");
    await new Jimp({ width: 1000, height: 800, color: 0x0000ffff }).write(src as `${string}.png`);
    const r = await runMediaTool(createCropTool(), { path: src, x: 100, y: 50, width: 200, height: 120 });
    if (r.isError) console.log("CROP-ERR:", r.output.slice(0, 200));
    expect(r.isError).toBe(false);
    const raw = (r as { rawImages?: { data: string; mimeType: string }[] }).rawImages;
    expect(raw).toHaveLength(1);
    expect(r.output).toContain("200×120");
    const clamp = await runMediaTool(createCropTool(), { path: src, x: 900, y: 700, width: 500, height: 500 });
    expect(clamp.isError).toBe(false); // 夹到边界内
  }, 60_000);

  it("③ media_convert：png → jpeg / png → webp（jsquash wasm 编码——产物魔数可验）", async () => {
    const d = fresh();
    const src = join(d, "c.png");
    await new Jimp({ width: 120, height: 90, color: 0x123456ff }).write(src as `${string}.png`);
    const jpg = await runMediaTool(createConvertTool(), { path: src, to: "image/jpeg" });
    expect(jpg.isError).toBe(false);
    const jpgRaw = (jpg as { rawImages?: { data: string; mimeType: string }[] }).rawImages!;
    expect(jpgRaw[0]!.mimeType).toBe("image/jpeg");
    expect(sniffMime(Buffer.from(jpgRaw[0]!.data, "base64"))).toBe("image/jpeg");
    const webp = await runMediaTool(createConvertTool(), { path: src, to: "image/webp" });
    expect(webp.isError).toBe(false);
    const webpRaw = (webp as { rawImages?: { data: string; mimeType: string }[] }).rawImages!;
    expect(webpRaw[0]!.mimeType).toBe("image/webp");
    expect(webpRaw[0]!.data.length).toBeGreaterThan(20);
  }, 60_000);

  it.skipIf(!hasFF)("④ video_clip：真 ffmpeg 剪 2s 测试片 0→1s → rawVideos mp4 片段（codec copy）", async () => {
    const d = fresh();
    const clip = join(d, "v.mp4");
    await new Promise<void>((resolve, reject) => {
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const ff = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=green:size=160x120:duration=2", "-pix_fmt", "yuv420p", "-r", "10", clip]);
      ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))));
    });
    const r = await runMediaTool(createVideoClipTool(), { path: clip, start_sec: 0, end_sec: 1 });
    expect(r.isError).toBe(false);
    const rv = (r as { rawVideos?: { data: string; mimeType: string }[] }).rawVideos!;
    expect(rv).toHaveLength(1);
    expect(rv[0]!.mimeType).toBe("video/mp4");
    const buf = Buffer.from(rv[0]!.data, "base64");
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(4, 8).toString("ascii")).toBe("ftyp"); // mp4 魔数
    const bad = await runMediaTool(createVideoClipTool(), { path: clip, start_sec: 2, end_sec: 1 });
    expect(bad.isError).toBe(true); // 参数卫戍
  }, 60_000);
});
