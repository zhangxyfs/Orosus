/** 启动审计横幅（§4.2 第 7 步 / §10「降级必须吵闹」三处留痕的 stdout 出口）——v15 起从 main.ts 抽出可测。
 *  分级（M4-B7 提前落地，2026-09-18 走查：已配 provider 的用户每次启动被 4 行品牌缺 key 降级刷屏）：
 *  失败全部是「品牌适配器缺 key」且已有可用 provider → 单行静默提示（明细 --dump-modules）；
 *  其余（真坏件 / 零配置首跑——新用户需要引导）保持吵闹横幅。 */
export interface AuditRow { name: string; state: string; failReason?: string }

const BRAND_NO_KEY = /^配置校验失败：apiKey/;

export function banner(h: { graph(): { audit(): AuditRow[] } }, opts: { dumpModules?: boolean } = {}): string[] {
  if (opts.dumpModules) return [];
  const audit = h.graph().audit();
  const failed = audit.filter((a) => a.state === "failed");
  const active = audit.filter((a) => a.state === "active");
  const providerUsable = active.some((a) => a.name.startsWith("provider-"));
  const brandNoKey = failed.filter((a) => a.name.startsWith("provider-") && BRAND_NO_KEY.test(a.failReason ?? ""));
  const others = failed.filter((a) => !brandNoKey.includes(a));
  if (brandNoKey.length > 0 && others.length === 0 && providerUsable) {
    return [`[orosus] ${active.length} 个模块已激活；${brandNoKey.length} 个品牌适配器未配 key 静默降级（按需配置 config.toml，明细 --dump-modules）`];
  }
  if (failed.length > 0) {
    const lines = [`⚠ ${failed.length} 个模块降级（完整表：orosus --dump-modules）：`];
    for (const a of failed) lines.push(`  - ${a.name}: ${a.failReason ?? ""}`);
    return lines;
  }
  return [`[orosus] ${active.length} 个模块已激活`];
}
