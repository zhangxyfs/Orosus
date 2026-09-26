import { resolve, sep } from "node:path";

/**
 * 写协调闸（M4.5 T7 / 决策 24——照 Reasonix 抄收窄版，五条规则落这块 + runner 的写绑定）：
 *  ① 报备：要写文件的子代理必须报备写路径（禁通配符、限项目内、Windows 大小写折叠归一）；
 *  ② 撞车排队：报备重叠（含目录包含）后到者等先到者干完——FIFO；**闸随持闸者结束释放**
 *    （完成/失败/被停/会话关闭都算结束——被停的占着闸不放就是另一种死锁）；
 *    **同血缘快败**：持闸/排队的正是排队者的先代 → 立即失败不排队（父握闸等撞车前台孙代理 = 必死锁）；
 *  ③ bash / 未报备的写手一律算「写整仓」（无法预知 shell 会写哪，保守处理）；
 *  ④ 整仓屏障：整仓排队者在队首时，后来的写者不许插队（防其饿死）；
 *  ⑤ 主对话写预约：主对话自己要写文件时做同样检查——不占子代理位，撞了立即让那步失败重试而不是干等。
 */

/** 报备归一（决策 24①）：resolve 到项目内绝对路径、win32 大小写折叠、统一分隔符比较。
 *  通配符与逃出项目根直接拒绝（fail-closed——报备是排队依据，模糊报备等于没有报备）。 */
export function normalizeClaimPath(cwd: string, p: string): { ok: true; path: string } | { ok: false; error: string } {
  if (/[<*?>|]/.test(p)) return { ok: false, error: `写路径报备禁用通配符/非法字符：${p}（报具体文件或目录）` };
  const abs = resolve(cwd, p);
  const cwdAbs = resolve(cwd);
  const fold = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);
  if (fold(abs) !== fold(cwdAbs) && !fold(abs).startsWith(fold(cwdAbs) + sep)) {
    return { ok: false, error: `写路径报备须在项目目录内：${p}（解析到 ${abs}，项目根 ${cwdAbs}）` };
  }
  return { ok: true, path: fold(abs).split(sep).join("/") };
}

/** 子路径判定（写绑定用）：child === parent 或 child 在 parent 目录边界内（parent 须已归一）。 */
export function claimContains(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

export interface WriteClaim {
  /** 归一后的报备路径（空 + wholeRepo=false = 只读代理不占闸）。 */
  paths: string[];
  /** 算整仓（bash / 未报备的写手）。 */
  wholeRepo: boolean;
}

interface Waiter {
  agentId: string;
  claim: WriteClaim;
  ancestors: string[];
  resolve: () => void;
  reject: (err: Error) => void;
}

const claimsOverlap = (a: WriteClaim, b: WriteClaim): boolean => {
  if (a.wholeRepo || b.wholeRepo) return true;
  return a.paths.some((p) => b.paths.some((q) => claimContains(p, q) || claimContains(q, p)));
};

export interface WriteGate {
  /** 排队获取写权：立即可跑 = 已是持闸者；撞车 = 排队（promise 在轮到时解决）；
   *  同血缘撞车 = 立即 reject（带指路文案）。等待期间不撒手（并发位纪律由调用方管——先占位再排闸）。 */
  acquire(agentId: string, claim: WriteClaim, ancestors: string[]): Promise<void>;
  /** 结束放闸（完成/失败/被停/会话关闭都调这个）：持闸者释放并放行队首；排队者被移出并 reject（按失败收场）。 */
  release(agentId: string): void;
  /** 主对话写预约（决策 24②尾）：不占位、立即判定——撞了让这一步失败重试而不是干等。含排队中的报备（意图已声明）。 */
  checkMainWrite(rawPaths: string[]): { ok: true } | { ok: false; error: string };
  /** 在册报备快照（诊断/测试）。 */
  snapshot(): { holders: { agentId: string; claim: WriteClaim }[]; queue: { agentId: string; claim: WriteClaim }[] };
}

/** 会话级写协调闸（一 harness 一实例——runner 持有，主对话写预约经 harness 挂主 bus 检查）。 */
export function createWriteGate(cwd: string): WriteGate {
  const holders = new Map<string, WriteClaim>();
  const queue: Waiter[] = [];

  const pump = (): void => {
    // 整仓屏障：队首起第一个整仓排队者之后的所有人本轮不许启动（不插队）
    let barrier = false;
    for (let i = 0; i < queue.length; i++) {
      const w = queue[i]!;
      if (barrier) break;
      if (w.claim.wholeRepo) barrier = true; // 本位先尝试启动；其后的等下一轮
      const conflict = [...holders].some(([, c]) => claimsOverlap(c, w.claim));
      if (conflict) continue; // 还有人挡着——留在队里（其后的人不因此受堵：细粒度报备的意义）
      queue.splice(i, 1);
      i--;
      holders.set(w.agentId, w.claim);
      w.resolve();
    }
  };

  return {
    acquire(agentId, claim, ancestors) {
      // 同血缘快败：在册（持闸或排队）报备重叠且是先代 → 立即失败（父等孙、孙等父都死锁，快败防互等）
      const kin = (id: string): boolean => ancestors.includes(id);
      for (const [hid, c] of holders) {
        if (kin(hid) && claimsOverlap(c, claim)) {
          return Promise.reject(new Error(
            `写报备撞车且持闸的是上级代理——不死锁，本单立即失败（报备：${claim.wholeRepo ? "整仓" : claim.paths.join("、")}）。` +
            `出路：上级代理自己完成这步写入，或改派只读子代理`,
          ));
        }
      }
      for (const w of queue) {
        if (kin(w.agentId) && claimsOverlap(w.claim, claim)) {
          return Promise.reject(new Error(
            `写报备撞车且排队的是上级代理——不死锁，本单立即失败（报备：${claim.wholeRepo ? "整仓" : claim.paths.join("、")}）。` +
            `出路：上级代理自己完成这步写入，或改派只读子代理`,
          ));
        }
      }
      const conflict = [...holders].some(([, c]) => claimsOverlap(c, claim));
      // 整仓屏障：已有整仓排队者在等 → 后来者不许插队（防整仓者饿死）
      const barrier = queue.some((w) => w.claim.wholeRepo);
      if (!conflict && !barrier) {
        holders.set(agentId, claim);
        return Promise.resolve();
      }
      return new Promise<void>((res, rej) => { queue.push({ agentId, claim, ancestors, resolve: res, reject: rej }); });
    },
    release(agentId) {
      const waiterIdx = queue.findIndex((w) => w.agentId === agentId);
      if (waiterIdx >= 0) {
        const w = queue.splice(waiterIdx, 1)[0]!;
        w.reject(new Error("已被停止——排队中的写单子按失败收场（写闸随之让位）"));
        return;
      }
      holders.delete(agentId);
      pump();
    },
    checkMainWrite(rawPaths) {
      // 主对话写的是哪几个路径（归一失败按整仓处理——保守）
      const norm = rawPaths.map((p) => normalizeClaimPath(cwd, p));
      const main: WriteClaim = {
        paths: norm.filter((n) => n.ok).map((n) => (n as { ok: true; path: string }).path),
        wholeRepo: norm.some((n) => !n.ok) || rawPaths.length === 0,
      };
      const hit = (c: WriteClaim): boolean => claimsOverlap(c, main);
      for (const [id, c] of holders) {
        if (hit(c)) {
          return { ok: false, error: `写路径与在跑子代理的写报备撞车（子代理 ${id}：${c.wholeRepo ? "整仓（bash/未报备）" : c.paths.join("、")}）——等它跑完再重试这一步（tool-subagent__tasks 可看进度）` };
        }
      }
      for (const w of queue) {
        if (hit(w.claim)) {
          return { ok: false, error: `写路径与排队中子代理的写报备撞车（子代理 ${w.agentId}：${w.claim.wholeRepo ? "整仓（bash/未报备）" : w.claim.paths.join("、")}）——等它跑完再重试这一步` };
        }
      }
      return { ok: true };
    },
    snapshot() {
      return {
        holders: [...holders].map(([agentId, claim]) => ({ agentId, claim })),
        queue: queue.map((w) => ({ agentId: w.agentId, claim: w.claim })),
      };
    },
  };
}
