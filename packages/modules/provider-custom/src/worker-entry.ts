// release-npm T3（D4=B/G4）：worker 入口探测——bundle 后本模块代码平铺 dist 根，同目录
// media-worker.js 优先（发行形态），缺失回退 media-worker.ts（dev 源码形态直跑）——零配置双环境
// 自适配。模块内自实现轻量 helper（boundaries 禁 import core；tool-media/imaging-worker 同款双写，
// tool-peers env.ts 先例）。
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function workerEntryUrl(metaUrl: string, name: string): URL {
  const dir = dirname(fileURLToPath(metaUrl));
  const js = join(dir, `${name}.js`);
  return existsSync(js) ? pathToFileURL(js) : new URL(`./${name}.ts`, metaUrl);
}
