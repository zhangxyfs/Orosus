// m5-media F10 imaging worker 入口（tool-media 自有——与 provider-custom/media-worker 同形态双写）。
import { parentPort } from "node:worker_threads";
import { processImage } from "./imaging.ts";

if (parentPort !== null) {
  parentPort.on("message", (msg: { id: number; buffer: Uint8Array; spec: { maxEdge: number; tokenTier: number }; region?: { x: number; y: number; width: number; height: number } }) => {
    (async () => {
      try {
        const buf = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
        const r = await processImage(buf, msg.spec, msg.region);
        parentPort!.postMessage({ id: msg.id, ok: true, r }, [r.buffer.buffer as ArrayBuffer]);
      } catch (err) {
        parentPort!.postMessage({ id: msg.id, ok: false, error: String(err instanceof Error ? err.message : err) });
      }
    })();
  });
}
