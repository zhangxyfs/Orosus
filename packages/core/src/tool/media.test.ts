import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type DiagSink, type DiagRecord } from "../diag/logger.ts";
import { base64Bytes, persistRawImages, RAW_IMAGE_LIMIT_BYTES } from "./media.ts";
import type { ToolImageMime } from "@orosus/contracts/tool";

const sink = (): DiagSink & { records: DiagRecord[] } => {
  const records: DiagRecord[] = [];
  return { records, write: (r) => void records.push(r), flush: () => Promise.resolve(), close: () => Promise.resolve() };
};

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const setup = () => {
  dir = mkdtempSync(join(tmpdir(), "orosus-media-"));
  const s = sink();
  const log = createLogger(s, "test");
  let seq = 0;
  return { log, records: s.records, seq: () => ++seq, mediaDir: join(dir, "media") };
};

describe("persistRawImages（m5-media F2——rawImages 落盘媒资库）", () => {
  it("① 正常落盘：base64 → 媒资库文件（media-<seq>-<safe>.<ext>，0o600 内容字节精确），返回路径引用", () => {
    const { log, seq, mediaDir } = setup();
    const out = persistRawImages(
      [{ data: "QUJD", mimeType: "image/png" }, { data: "QUJD", mimeType: "image/jpeg" }],
      { dir: mediaDir, seq, callId: "call_1", log },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ mimeType: "image/png" });
    expect(out[0]!.path).toMatch(/[\\/]media-1-call_1\.png$/);
    expect(out[1]!.path).toMatch(/[\\/]media-2-call_1\.jpg$/);
    expect(readFileSync(out[0]!.path).toString("utf8")).toBe("ABC"); // base64 解码精确
    expect(existsSync(mediaDir)).toBe(true);
  });

  it("② 坏条目剔除不炸：空 data / 非白名单 mime（运行期防御）/ 超帽——全 warn 留痕，好条目照常", () => {
    const { log, seq, mediaDir, records } = setup();
    const overCapData = "A".repeat(Math.ceil(((RAW_IMAGE_LIMIT_BYTES + 1) * 4) / 3));
    const out = persistRawImages(
      [
        { data: "", mimeType: "image/png" },
        { data: "QUJD", mimeType: "image/svg+xml" as unknown as ToolImageMime },
        { data: overCapData, mimeType: "image/png" },
        { data: "REJD", mimeType: "image/webp" },
      ],
      { dir: mediaDir, seq, callId: "c", log },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ mimeType: "image/webp" });
    expect(records.some((r) => r.code === "kernel.tool.media-skip")).toBe(true);
    expect(records.some((r) => r.code === "kernel.tool.media-oversize")).toBe(true);
  });

  it("③ 目录创建失败降级：占位文件挡路 → 空数组 + 一次 warn（不炸——工具契约错误带内）", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-media-block-"));
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "占位文件——mkdirSync 必炸", "utf8");
    const s = sink();
    const log = createLogger(s, "test");
    const out = persistRawImages([{ data: "QUJD", mimeType: "image/png" }], { dir: blocked, seq: () => 1, callId: "c", log });
    expect(out).toEqual([]);
    expect(s.records.some((r) => r.code === "kernel.tool.media-dir-failed")).toBe(true);
  });

  it("④ 写盘失败跳过该图：文件名被同名目录占用 → 该条剔除，其余照常", () => {
    const { log, records, mediaDir } = setup();
    persistRawImages([{ data: "QUJD", mimeType: "image/png" }], { dir: mediaDir, seq: () => 1, callId: "c", log }); // 先建出 media/ 目录
    rmSync(join(mediaDir, "media-1-c.png"));
    mkdirSync(join(mediaDir, "media-1-c.png")); // 用目录占住同名路径——下一次写 media-1-c.png 必炸（writeFileSync 撞目录）
    const out = persistRawImages([{ data: "QUJD", mimeType: "image/png" }], { dir: mediaDir, seq: () => 1, callId: "c", log });
    expect(out).toEqual([]);
    expect(records.some((r) => r.code === "kernel.tool.media-write-failed")).toBe(true);
  });
});

describe("base64Bytes（占位行/帽判定同口径）", () => {
  it("padded base64 折算 3/4；空串 0", () => {
    expect(base64Bytes("QUJD")).toBe(3); // "ABC"
    expect(base64Bytes("")).toBe(0);
  });
});
