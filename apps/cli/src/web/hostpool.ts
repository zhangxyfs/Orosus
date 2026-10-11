/** HostPool —— web 批 T2 项目池：server 生命周期内的会话托管面（host 写侧 + viewer 只读 LRU）。
 *  - host（create）：写侧装配（PresenceWriter kind=web、dispatch/队列/close 序见 hosted.ts）；
 *    同 resumeSid 幂等（重复 create 沿用既有托管，不重装配）。
 *  - viewer（§4-11）：只读 harness（createHarness({resume})——不发 prompt 永不写盘不撞锁，无
 *    presence），LRU 8（自创值登记——§5 表）逐出即 close；host 接管同会话时只读化身先关。
 *    已 host 的会话 viewer() 直返 host 实例（同一会话不开第二个化身）。
 *  - switchCurrent/current：前端「当前会话」游标（server 持——/web 交接后指向交接会话，
 *    /api/bootstrap currentSid 消费〔T9〕；无则前端开最新）。
 *  - closeAll（G15 SIGINT 清退序）：全部 host+viewer 逐个 close（幂等），清表清游标。
 *  cwd 反查：viewer 的 cwd 取目标会话自身 header 首行（session/header 带 cwd——§2 buckets.ts 的
 *  单会话特例；全桶反查缓存是 T9 交付物）。 */
import { join } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { locateSessionFile } from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import { orosusHome } from "@orosus/contracts/home";
import { HostedSession } from "./hosted.ts";

/** viewer 只读化身容量（自创值登记——方案 §5 表：改值先查那里）。 */
export const VIEWER_LRU = 8;

/** 会话 header 首行读 cwd（预算 4KB——header 含 moduleSummary 三计数，恒小）。 */
const headerCwdOf = (file: string): string | undefined => {
  try {
    const buf = Buffer.alloc(4096);
    const fd = openSync(file, "r");
    try {
      const n = readSync(fd, buf, 0, buf.length, 0);
      const nl = buf.indexOf(0x0a);
      const line = buf.toString("utf8", 0, Math.min(n, nl === -1 ? buf.length : nl));
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // 坏行/无 header——调用方兜底 process.cwd()
  }
};

/** 无头 CommandUi（core 缺省拒绝式四法同款）：T5 WebCommandUi（bridge-ui.ts）接位前的缺省装配——
 *  交互式命令 fail-closed，不炸托管。 */
const headlessUi: CommandUi = {
  ask: async () => { throw new Error("无交互环境（headless）——web 交互桥未装配（T5 接位）"); },
  askSecret: async () => { throw new Error("无交互环境（headless）——web 交互桥未装配（T5 接位）"); },
  choose: async () => { throw new Error("无交互环境（headless）——web 交互桥未装配（T5 接位）"); },
  confirm: async () => { throw new Error("无交互环境（headless）——web 交互桥未装配（T5 接位）"); },
};

export class HostPool {
  /** sessions 根（= join(home, "sessions")——与 CLI sessionsRoot 同形；路由存在性判据共用）。 */
  readonly root: string;
  private readonly commandUi: CommandUi;
  private readonly hosts = new Map<string, HostedSession>();
  private readonly viewers = new Map<string, HostedSession>();
  private viewerOrder: string[] = [];
  private currentSid: string | undefined;

  constructor(init: { home?: string; commandUi?: CommandUi } = {}) {
    this.root = join(init.home ?? orosusHome(), "sessions");
    this.commandUi = init.commandUi ?? headlessUi;
  }

  /** 写侧托管查询（viewer-only 会话 = undefined）。 */
  host(sid: string): HostedSession | undefined {
    return this.hosts.get(sid);
  }

  /** 只读打开（LRU 8）：已 host 直返 host；未在池 = 装配 viewer（会话不在盘 → 抛错）。 */
  async viewer(sid: string): Promise<HostedSession> {
    const hosted = this.hosts.get(sid);
    if (hosted !== undefined) return hosted;
    const cached = this.viewers.get(sid);
    if (cached !== undefined) {
      this.touchViewer(sid);
      return cached;
    }
    const loc = locateSessionFile(this.root, sid);
    if (loc === undefined) throw new Error(`会话 ${sid} 不存在`);
    const hs = new HostedSession({
      cwd: headerCwdOf(loc.file) ?? process.cwd(),
      resumeSid: sid,
      commandUi: this.commandUi,
      sessionsRoot: this.root,
      mode: "viewer",
    });
    await hs.ready;
    this.viewers.set(sid, hs);
    this.touchViewer(sid);
    this.evictViewers();
    return hs;
  }

  /** 写侧装配（/web 交接、POST /api/sessions〔T9〕）：同 resumeSid 幂等沿用；host 接管同会话的
   *  viewer 只读化身时先关再换（免双订阅浪费）。 */
  async create(opts: { cwd: string; resumeSid?: string; forkFrom?: string }): Promise<HostedSession> {
    if (opts.resumeSid !== undefined) {
      const existing = this.hosts.get(opts.resumeSid);
      if (existing !== undefined) return existing;
    }
    const staleViewer = opts.resumeSid !== undefined ? this.viewers.get(opts.resumeSid) : undefined;
    const hs = new HostedSession({
      cwd: opts.cwd,
      ...(opts.resumeSid !== undefined ? { resumeSid: opts.resumeSid } : {}),
      ...(opts.forkFrom !== undefined ? { forkFrom: opts.forkFrom } : {}),
      commandUi: this.commandUi,
      sessionsRoot: this.root,
    });
    await hs.ready;
    if (staleViewer !== undefined) {
      this.viewers.delete(opts.resumeSid!);
      this.viewerOrder = this.viewerOrder.filter((s) => s !== opts.resumeSid);
      await staleViewer.close().catch(() => undefined);
    }
    this.hosts.set(hs.sid, hs);
    return hs;
  }

  /** 前端「当前会话」游标（server 持——/web 交接后指向交接会话）。 */
  switchCurrent(sid: string): void {
    this.currentSid = sid;
  }

  current(): HostedSession | undefined {
    return this.currentSid === undefined ? undefined : this.hosts.get(this.currentSid);
  }

  /** 全部关停（G15 SIGINT 清退序——T1 onShutdown 注册位消费）：先清表（host 查询即刻失效）再逐个
   *  close（close 序见 HostedSession.close）。幂等。 */
  async closeAll(): Promise<void> {
    const all = [...this.hosts.values(), ...this.viewers.values()];
    this.hosts.clear();
    this.viewers.clear();
    this.viewerOrder = [];
    this.currentSid = undefined;
    await Promise.all(all.map((hs) => hs.close().catch(() => undefined)));
  }

  private touchViewer(sid: string): void {
    this.viewerOrder = this.viewerOrder.filter((s) => s !== sid);
    this.viewerOrder.push(sid);
  }

  private evictViewers(): void {
    while (this.viewers.size > VIEWER_LRU) {
      const victim = this.viewerOrder.shift();
      if (victim === undefined) break;
      const hs = this.viewers.get(victim);
      this.viewers.delete(victim);
      if (hs !== undefined) void hs.close().catch(() => undefined); // LRU 逐出即 close（§4-11）
    }
  }
}
