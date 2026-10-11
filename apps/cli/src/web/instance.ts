/** 实例文件（web 批 T1，G12 双开复用 / G15 token 恢复链）：~/.orosus/web/server.json 是
 *  「本机唯一 web server 实例」的单一事实源——{v,pid,port,startedAt,token}，0600 原子写（tmp+rename）。
 *  活实例探测（findLiveInstance）= 读文件 → pidAlive（EPERM=活——core wlock 同源判据）→
 *  fetch /api/health（10s 超时，自创值登记）双确认——Windows 纪律用 health 探测而非裸 TCP connect（§4-9）。
 *  起服 token 决策（reuseOrMintToken）：已存且形状合法 → 沿用（接管/重启场景，不重铸——旧标签页
 *  断连重试仍有效）；否则新铸（调用方起服后回写实例文件）。 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "@orosus/core";
import { isValidTokenShape, mintToken } from "./auth.ts";

/** 实例文件载荷（v=1 起始版本；演进时读侧拒旧版并按死实例处理）。 */
export interface WebInstance {
  v: 1;
  pid: number;
  port: number;
  startedAt: number;
  token: string;
}

/** 实例文件路径（home = orosusHome() 解析结果；GC9 实例数据落 ~/.orosus/web/）。 */
export function instanceFilePath(home: string): string {
  return join(home, "web", "server.json");
}

/** 读实例文件：缺文件/坏 JSON/形状不符 → undefined（按无实例处理，不让坏文件炸起服）。 */
export function readInstance(home: string): WebInstance | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.pid !== "number" || typeof r.port !== "number" || typeof r.startedAt !== "number" || typeof r.token !== "string") {
    return undefined;
  }
  return { v: 1, pid: r.pid, port: r.port, startedAt: r.startedAt, token: r.token };
}

/** 原子写实例文件：先写同目录 tmp（mode 0600——token 不落世界可读）再 rename 顶替，
 *  读侧永远读到完整文件（半写 JSON 会被 readInstance 判坏回落无实例）。 */
export function writeInstance(home: string, inst: WebInstance): void {
  mkdirSync(join(home, "web"), { recursive: true });
  const file = instanceFilePath(home);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(inst), { mode: 0o600, encoding: "utf8" });
  renameSync(tmp, file);
}

/** 删实例文件（SIGINT 清退序消费；不存在时静默——幂等）。 */
export function removeInstance(home: string): void {
  try {
    rmSync(instanceFilePath(home), { force: true });
  } catch { /* 退出路径不炸 */ }
}

/** 起服 token 决策（G15）：实例文件已存且 token 形状合法 → 沿用；否则新铸。
 *  沿用不重铸是「重启后旧标签页重试恢复」的前提——token 变了旧标签的 sessionStorage 即作废。 */
export function reuseOrMintToken(home: string): string {
  const existing = readInstance(home)?.token;
  return isValidTokenShape(existing) ? existing : mintToken();
}

/** 活实例探测（G12）：读文件 → pid 活 → /api/health 应答 {ok:true}（带实例 token；10s 超时）。
 *  任一环失败 = 无活实例（调用方起服接管）。fetchImpl/timeoutMs 注入面为测试预留。 */
export async function findLiveInstance(
  home: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WebInstance | undefined> {
  const inst = readInstance(home);
  if (inst === undefined || !pidAlive(inst.pid)) return undefined;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`http://127.0.0.1:${inst.port}/api/health`, {
      headers: { "x-orosus-token": inst.token },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.status !== 200) return undefined;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true ? inst : undefined;
  } catch {
    return undefined; // 探测失败（连接拒绝/超时/坏载荷）= 不活——起服接管
  }
}
