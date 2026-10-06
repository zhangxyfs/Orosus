import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** 产品权威版本号：monorepo 根 package.json 的 version（CLI 产品版本与之同步）。
 *  各 provider 模块拼 UA、CLI 启动横幅共用此常量——禁硬编码散落（版本漂移铁律）。
 *
 *  三级读链（release-npm T4/D5，同一逻辑双环境自证、无构建魔法）：
 *  ① 相对本文件上溯三级读 manifest——dev 仓库形态（packages/contracts/src → 仓库根）；
 *    命中后校验 name === "orosus"，异物视同未命中（bundle 后 chunk 在 dist 根、上三级出包外——
 *    项目本地安装场景可能撞宿主项目 manifest，防误报其版本；-g 安装通常不命中此路径）
 *  ② createRequire 自名解析 "orosus/package.json"——published 形态（up-walk node_modules/orosus；
 *    前提 = 发行 manifest 的 exports 显式写 "./package.json": "./package.json" 子路径，release 脚本生成）
 *  ③ "0.0.0-dev" 兜底——读不到不炸启动。 */
export function resolveVersionFrom(fromUrl: string): string {
  try {
    const m = createRequire(fromUrl)("../../../package.json") as { name?: string; version?: string };
    if (m?.name === "orosus" && typeof m.version === "string") return m.version;
  } catch { /* 落② */ }
  try {
    const p = createRequire(fromUrl).resolve("orosus/package.json");
    const m = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
    if (m?.name === "orosus" && typeof m.version === "string") return m.version;
  } catch { /* 落③ */ }
  return "0.0.0-dev";
}

const OROSUS_VERSION_VALUE: string = resolveVersionFrom(import.meta.url);
export const OROSUS_VERSION: string = OROSUS_VERSION_VALUE;

/** 出网请求统一 User-Agent（厂商后台「来源」列所见——Kimi 等按 UA 归因客户端）。 */
export const OROSUS_USER_AGENT = `Orosus/${OROSUS_VERSION}`;
