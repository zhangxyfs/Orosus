// m5-media F10 imaging worker 入口（tool-media 自有——与 provider-custom/media-worker 同形态双写）。
import { parentPort } from "node:worker_threads";
import { processImage } from "./imaging.ts";

if (parentPort !== null) {
  parentPort.on("message", (msg: { id: number; buffer: Uint8Array; spec: { maxEdge: number; tokenTier: number }; region?: { x: number; y: number; width: number; height: number } }) => {
    (async () => {
      try {
        const buf = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
        const r = await processImage(buf, msg.spec, msg.region);
        // 小输出 Buffer 走 node 内存池（共享 AB）——worker postMessage 直接 transfer 池 AB 报
        // "Cannot transfer object of unsupported type"（runProcess 发送侧同坑先例，注释在 imaging.ts；
        // dev 期输出多 >4KB 自有 AB 侥幸未炸，release-npm T3 dist 端到端走查实锤）。拷贝出自有 AB 再 transfer
        const ab = r.buffer.buffer.slice(r.buffer.byteOffset, r.buffer.byteOffset + r.buffer.byteLength) as ArrayBuffer;
        parentPort!.postMessage({ id: msg.id, ok: true, r: { ...r, buffer: Buffer.from(ab) } }, [ab]);
      } catch (err) {
        parentPort!.postMessage({ id: msg.id, ok: false, error: String(err instanceof Error ? err.message : err) });
      }
    })();
  });
}
