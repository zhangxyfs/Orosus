// m5-media F5 worker 线程件（pi image-resize 同款形态）：Jimp 解大图是 CPU 活（8MP 编码实测 ~300-500ms），
// 主线程跑会卡 TUI 帧——压缩全部走 worker。本文件是 worker 入口：收 { id, buffer, maxEdge, tokenTier }，
// 回 { id, buffer, width, height, mime }（transferList 零拷贝）。
import { parentPort } from "node:worker_threads";
import { resizeBuffer } from "./mediapipe-core.ts";

if (parentPort !== null) {
  parentPort.on("message", (msg: { id: number; buffer: Uint8Array; maxEdge: number; tokenTier: number }) => {
    (async () => {
      try {
        // structuredClone 过线程后是 Uint8Array（不是 Buffer 实例）——Jimp 只认 Buffer，就地包一层零拷贝视图
        const buf = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
        const out = await resizeBuffer(buf, { maxEdge: msg.maxEdge, tokenTier: msg.tokenTier });
        parentPort!.postMessage({ id: msg.id, ok: true, ...out }, [out.buffer.buffer as ArrayBuffer]);
      } catch (err) {
        parentPort!.postMessage({ id: msg.id, ok: false, error: String(err instanceof Error ? err.message : err) });
      }
    })();
  });
}
