import { createRequire } from "node:module";

/** 产品权威版本号：monorepo 根 package.json 的 version（CLI 产品版本与之同步）。
 *  各 provider 模块拼 UA、CLI 启动横幅共用此常量——禁硬编码散落（版本漂移铁律）。
 *  相对本文件上溯三级（packages/contracts/src → 仓库根）读取；读不到回退 "0.0.0-dev" 不炸启动。 */
function readVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return (req("../../../package.json") as { version?: string }).version ?? "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export const OROSUS_VERSION: string = readVersion();

/** 出网请求统一 User-Agent（厂商后台「来源」列所见——Kimi 等按 UA 归因客户端）。 */
export const OROSUS_USER_AGENT = `Orosus/${OROSUS_VERSION}`;
