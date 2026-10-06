import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { parseClaims, type Claim } from "./derive.ts";

export interface SelfInfo { sid: string; bucketDir: string; sessionDir: string; cwd: string; transcriptPath: string }
export interface PeersConfig { workspaceMemory: boolean; sessionPeers: boolean; injectIndex: boolean; windowMinutes: number; leaseMinutes: number; sessionsRoot?: string; memoryBase?: string }
// ↑ 七键全量，与 Produces 接口块同面——缺键即 excess-property TS2353（四轮复审勘正）

const atomicWrite = (file: string, text: string): void => {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

export class PeersEnv {
  private selfValue: SelfInfo | undefined;
  private readonly cfg: PeersConfig;
  constructor(cfg: PeersConfig) { this.cfg = cfg; }   // 禁 constructor 参数属性语法——Node 24 strip-only 不支持（本仓两度踩坑在档）
  get self(): SelfInfo | undefined { return this.selfValue; }
  get sessionsRoot(): string { return this.cfg.sessionsRoot ?? join(orosusHome(), "sessions"); }
  get memoryBase(): string { return this.cfg.memoryBase ?? join(orosusHome(), "memories", "projects"); }
  get windowMs(): number { return this.cfg.windowMinutes * 60_000; }
  get leaseMs(): number { return this.cfg.leaseMinutes * 60_000; }
  onSessionStart(e: { session_id: string; transcript_path: string; cwd: string }): void {
    const sessionDir = dirname(dirname(e.transcript_path));           // <bucket>/<sid>
    this.selfValue = { sid: e.session_id, bucketDir: dirname(sessionDir), sessionDir, cwd: e.cwd, transcriptPath: e.transcript_path };
  }
  bootById(sid: string): boolean {          // D26 中途启用补捞：session/start 已过（reload 不重放），按 id 扫桶定位
    let buckets: string[];
    try { buckets = readdirSync(this.sessionsRoot); } catch { return false; }
    for (const b of buckets) {
      const agents = join(this.sessionsRoot, b, sid, "agents");
      const main = ["session.jsonl", "session.sqlite"].map(n => join(agents, n)).find(existsSync);
      if (main !== undefined) {
        this.onSessionStart({ session_id: sid, transcript_path: main, cwd: process.cwd() });   // cwd 兜底（harness.ts:697 同式）
        return true;
      }
    }
    return false;
  }
  memoryDir(): string | undefined {
    return this.selfValue === undefined ? undefined : join(this.memoryBase, basename(this.selfValue.bucketDir), "memory");
  }
  siblingSessionDirs(): { sid: string; dir: string }[] {
    if (this.selfValue === undefined) return [];
    try {
      return readdirSync(this.selfValue.bucketDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== this.selfValue!.sid)
        .map(d => ({ sid: d.name, dir: join(this.selfValue!.bucketDir, d.name) }));
    } catch { return []; }
  }
  private claimsFile(): string { return join(this.selfValue!.sessionDir, "claims.json"); }   // D4
  writeClaims(claims: Claim[]): void {
    if (this.selfValue === undefined) return;
    mkdirSync(this.selfValue.sessionDir, { recursive: true });
    atomicWrite(this.claimsFile(), `${JSON.stringify(claims, null, 2)}\n`);
  }
  readClaims(now: number): Claim[] {
    if (this.selfValue === undefined) return [];
    try { return parseClaims(readFileSync(this.claimsFile(), "utf8"), now); }
    catch { return []; }
  }
}
