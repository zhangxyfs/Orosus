/** 启动审计横幅（§4.2 第 7 步 / §10「降级必须吵闹」三处留痕的 stdout 出口）——v15 起从 main.ts 抽出可测。
 *  分级（M4-B7 提前落地 + M4-2 T15 零配置引导）：
 *  失败全部是「品牌适配器缺 key」且已有可用 provider → 单行静默提示（明细 --dump-modules）；
 *  无可用 provider 且无真坏件（零配置首跑）→ 引导语指路 /provider（不是降级，是没开始——不再吓人 ⚠）；
 *  其余（真坏件）保持吵闹横幅。 */
export interface AuditRow { name: string; state: string; failReason?: string }

const BRAND_NO_KEY = /^配置校验失败：apiKey/;

export function banner(h: { graph(): { audit(): AuditRow[] } }, opts: { dumpModules?: boolean; modelConfigured?: boolean } = {}): string[] {
  if (opts.dumpModules) return [];
  const audit = h.graph().audit();
  const failed = audit.filter((a) => a.state === "failed");
  const active = audit.filter((a) => a.state === "active");
  // model 可解析由宿主注入（needsProviderSetup 判定——audit 面看不到 config/model；缺省启发式 =
  // 有 active provider-* 模块，纯单测面沿用）。provider-custom 空表也 active——真实零配置必须靠注入区分（M4-2 T15）。
  const providerUsable = opts.modelConfigured ?? active.some((a) => a.name.startsWith("provider-"));
  const brandNoKey = failed.filter((a) => a.name.startsWith("provider-") && BRAND_NO_KEY.test(a.failReason ?? ""));
  const others = failed.filter((a) => !brandNoKey.includes(a));
  if (brandNoKey.length > 0 && others.length === 0 && providerUsable) {
    return [`[orosus] ${active.length} 个模块已激活；${brandNoKey.length} 个品牌适配器未配 key 静默降级（按需配置 config.toml，明细 --dump-modules）`];
  }
  if (!providerUsable && others.length === 0) {
    // 零配置首跑——不是降级，是没开始（M4-2 T15/B7 剩余）
    return ["[orosus] 尚未配置任何模型提供商——运行 /provider 开始配置（选平台 → 粘贴 apiKey 即用），或参照 docs/developers.md 手写 config.toml"];
  }
  if (failed.length > 0) {
    const lines = [`⚠ ${failed.length} 个模块降级（完整表：orosus --dump-modules）：`];
    for (const a of failed) lines.push(`  - ${a.name}: ${a.failReason ?? ""}`);
    return lines;
  }
  return [`[orosus] ${active.length} 个模块已激活`];
}
