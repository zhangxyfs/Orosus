import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Jimp } from "jimp";
import {
  IMAGE_TOKEN_BUDGET_TIERS, PIXELS_PER_TOKEN,
  loadToJimp, resizeBuffer, scaleFor, scaledDims, tokenBudgetPixels,
} from "./mediapipe-core.ts";
import { ensureSendCopy, prepareImagesForWire, sniffImageDims } from "./mediapipe.ts";
import type { ModelMessage } from "@orosus/contracts/provider";

let dir: string | undefined;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } });
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-m5pipe-")));

describe("token 分档反解（qwen 口径——双口径取更严）", () => {
  it("① 三档常量 + 反解数学：tier×750 = 像素预算；scale = min(1, 边帽, sqrt(预算/像素))", () => {
    expect([...IMAGE_TOKEN_BUDGET_TIERS]).toEqual([256, 1024, 2048]);
    expect(tokenBudgetPixels(2048)).toBe(2048 * PIXELS_PER_TOKEN); // 1.536M px
    // 4096×2048：边帽给 0.5（→2048×1024=2.10M px），token 帽给 sqrt(1536000/8388608)≈0.428——token 更严生效
    expect(scaleFor(4096, 2048, { maxEdge: 2048, tokenTier: 2048 })).toBeLessThan(0.5);
    expect(scaleFor(4096, 2048, { maxEdge: 2048, tokenTier: 2048 })).toBeCloseTo(Math.sqrt(1_536_000 / (4096 * 2048)), 5);
    // 小图零缩放；细长图（6000×100）：边帽绑（60/6000=0.1 → 600×10）
    expect(scaleFor(100, 100, { maxEdge: 2048, tokenTier: 2048 })).toBe(1);
    expect(scaleFor(6000, 100, { maxEdge: 2048, tokenTier: 2048 })).toBeCloseTo(2048 / 6000, 5);
    const d = scaledDims(4096, 2048, 0.4276);
    expect(d.w % 2).toBe(0);
    expect(d.h % 2).toBe(0); // 偶数边对齐
  });
});

describe("尺寸嗅探（零解码快路径）", () => {
  it("② PNG / JPEG 头部直读尺寸；GIF / WEBP(VP8X) 手工头", async () => {
    const d = fresh();
    const pngPath = join(d, "a.png");
    await new Jimp({ width: 321, height: 123, color: 0xff0000ff }).write(pngPath as `${string}.png`);
    expect(sniffImageDims(readFileSync(pngPath))).toEqual({ w: 321, h: 123 });
    const jpgPath = join(d, "b.jpg");
    await new Jimp({ width: 200, height: 100, color: 0x00ff00ff }).write(jpgPath as `${string}.jpg`);
    expect(sniffImageDims(readFileSync(jpgPath))).toEqual({ w: 200, h: 100 });
    // GIF：GIF89a + 逻辑屏幕头（宽高 LE）
    const gif = Buffer.alloc(13);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(sniffImageDims(gif)).toEqual({ w: 320, h: 240 });
    // WEBP VP8X：RIFF…WEBP + 四字符 + 特征字节 + 24 位画布宽高（-1 编码）
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.writeUInt32LE(18, 4);
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUInt32LE(10, 16);
    webp[20] = 0x10;
    const w = 640 - 1;
    const h = 480 - 1;
    webp[24] = w & 0xff; webp[25] = (w >> 8) & 0xff; webp[26] = (w >> 16) & 0xff;
    webp[27] = h & 0xff; webp[28] = (h >> 8) & 0xff; webp[29] = (h >> 16) & 0xff;
    expect(sniffImageDims(webp)).toEqual({ w: 640, h: 480 });
    // 非图内容 → undefined（调用方按未知回落原件）
    expect(sniffImageDims(Buffer.from("hello world text"))).toBeUndefined();
  });
});

describe("webp 解码（@jsquash/wasm——Jimp 不认 webp，kimi webp-decode 同源）", () => {
  it("③ webp → Jimp 位图 → 降采样重编码 png（webp 发送副本全链）", async () => {
    const req = createRequire(import.meta.url);
    const { init: initEnc } = await import("@jsquash/webp/encode.js");
    const encJs = req.resolve("@jsquash/webp/encode.js");
    const { dirname, join: j } = await import("node:path");
    // 编码器 simd/非 simd 双二进制按 CPU 探测选（与包内 wasm-feature-detect 同判据；locateFile 在 Node 走 fetch 不通）
    const { simd } = await import("wasm-feature-detect");
    const { readFile } = await import("node:fs/promises");
    const wasmFile = await simd() ? "webp_enc_simd.wasm" : "webp_enc.wasm";
    const WA = (globalThis as unknown as { WebAssembly: { Module: new (b: Buffer) => unknown } }).WebAssembly;
    initEnc(new WA.Module(await readFile(j(dirname(encJs), "codec", "enc", wasmFile))) as never);
    const { encode } = await import("@jsquash/webp");
    // 100×100 红 ImageData → webp
    const px = new Uint8Array(100 * 100 * 4).fill(255).map((v, i) => (i % 4 === 3 ? 255 : v));
    const webpBuf = Buffer.from(await encode({ data: px, width: 100, height: 100 }));
    const img = await loadToJimp(webpBuf);
    expect(img.width).toBe(100);
    expect(img.height).toBe(100);
    // maxEdge 50 → 50×50 png（webp 出幅统一 png——Jimp 无 webp 编码器）
    const out = await resizeBuffer(webpBuf, { maxEdge: 50, tokenTier: 2048 });
    expect(out.mime).toBe("image/png");
    expect(out.width).toBe(50);
    const re = await loadToJimp(out.buffer);
    expect(re.width).toBe(50);
  }, 30_000);
});

describe("发送副本（ensureSendCopy——原件不动、一次成本、缓存命中）", () => {
  it("④ 超尺寸图 → 副本生成（命名 .send-<edge>-<tier>、尺寸达标、worker 或 inline 皆过）；小图直返原件", async () => {
    const d = fresh();
    const bigPath = join(d, "media-1-c1.png");
    await new Jimp({ width: 3000, height: 3000, color: 0x0000ffff }).write(bigPath as `${string}.png`); // 9M px > 1.536M 预算 → token 绑
    const r = await ensureSendCopy(bigPath);
    expect(r.resized).toBe(true);
    expect(r.path).not.toBe(bigPath);
    expect(r.path).toMatch(/\.send-2048-2048\.png$/);
    const copy = readFileSync(r.path);
    const dims = sniffImageDims(copy);
    expect(dims).toBeDefined();
    // 3000×3000 → scale = sqrt(1536000/9000000) ≈ 0.4133 → ~1240×1240
    expect(dims!.w).toBeLessThanOrEqual(1242);
    expect(dims!.w).toBeGreaterThanOrEqual(1230);
    expect(sniffImageDims(readFileSync(bigPath))).toEqual({ w: 3000, h: 3000 }); // 原件不动（磁盘事实源）
    // 二次调用：副本已在 → 同路径（缓存命中，不再编码——按 existsSync 判定）
    const r2 = await ensureSendCopy(bigPath);
    expect(r2.path).toBe(r.path);
    // 小图：达标直返原件、零副本
    const smallPath = join(d, "media-2-c2.png");
    await new Jimp({ width: 400, height: 300, color: 0xff0000ff }).write(smallPath as `${string}.png`);
    const r3 = await ensureSendCopy(smallPath);
    expect(r3.resized).toBe(false);
    expect(r3.path).toBe(smallPath);
    expect(existsSync(join(d, "media-2-c2.send-2048-2048.png"))).toBe(false);
  }, 60_000);
});

describe("prepareImagesForWire（translate 前编排——消息级换副本）", () => {
  it("⑤ user 消息与 toolResult parts 的超尺寸图换副本路径；webp mime 换 png；达标图与无图消息原引用直返", async () => {
    const d = fresh();
    const big = join(d, "media-1-c1.png");
    await new Jimp({ width: 3000, height: 3000, color: 0x00ff00ff }).write(big as `${string}.png`);
    const small = join(d, "media-2-c2.png");
    await new Jimp({ width: 100, height: 100, color: 0xff0000ff }).write(small as `${string}.png`);
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ kind: "text", text: "看" }, { kind: "image", path: big, mimeType: "image/png" }] },
      { role: "toolResult", callId: "c1", output: "o", isError: false, parts: [{ kind: "image", path: small, mimeType: "image/webp" }] },
    ];
    const out = await prepareImagesForWire(msgs);
    expect(out[0]).not.toBe(msgs[0]); // 大图消息换新对象
    const userImg = (out[0] as { content: { kind: string; path?: string; mimeType?: string }[] }).content[1]!;
    expect(userImg.path).toMatch(/\.send-2048-2048\.png$/);
    expect(userImg.mimeType).toBe("image/png");
    // 小图 toolResult：路径不动；webp mime 不换（未产副本——mime 换装只随副本）
    expect(out[1]).toBe(msgs[1]);
    // 无图消息：原引用直返（零开销）
    const plain: ModelMessage[] = [{ role: "user", content: [{ kind: "text", text: "纯文本" }] }];
    expect(await prepareImagesForWire(plain)).toBe(plain);
  }, 60_000);
});
