/** bash 复合命令分段（Reasonix bash_decompose 参照——调研底稿 §4）。
 *  按顶层 ;/&&/||/| 拆段 → 每段提取命令前两词作为规则前缀（包管理器 run 取三词）。
 *  含 eval/xargs/嵌套 -c/$/反引号 → 返回 []（= require-human，不可自动记规则）。 */
export function decomposeCommand(cmd: string): string[] {
  if (/[\$`]|\beval\b|\bxargs\b|\s-c\s/.test(cmd)) return [];
  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((s) => s.trim() !== "");
  return segments.map((seg) => {
    const words = seg.trim().split(/\s+/);
    const first = words[0] ?? "";
    if (/^(npm|pnpm|yarn|bun)$/.test(first) && words[1] === "run") return words.slice(0, 3).join(" ");
    return words.slice(0, 2).join(" ");
  });
}

/** unanalyzable 补集检测（kimi 方案——调研底稿 §3）：AST 判定放行的三类展开符（$/反引号/通配符）。
 *  融入 dangerousGate 的 unanalyzable 三态（复用 memoryKey=null 面板退化）——不另起检测链。 */
export function isUnanalyzable(cmd: string): boolean {
  return /[\$`]|\*(?!\})|\[(?![\d])/.test(cmd) || /\beval\b|\bxargs\b|\s-c\s/.test(cmd);
}
