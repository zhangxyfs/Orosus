/** bash 复合命令分段（Reasonix bash_decompose 参照——调研底稿 §4）。
 *  按顶层 ;/&&/||/| 拆段、返回各段**完整文本**。含 eval/xargs/嵌套 -c/$/反引号 → 返回 []（= require-human，
 *  不可自动记规则）。
 *  MA-02/03 修复（2026-09-28 code review）：不再把段截断成「前两词」（npm run 三词特例随之退役）——
 *  匹配一律对完整段文本做：旧截断使 `bash(git push *)` 这类 ≥2 词前缀规则永不命中（deny 拦不住），
 *  而 `bash(npm test)` 精确规则反而误吞 `npm test --watch`。规则生成只取首词（index.ts split(" ")[0]），
 *  与段长无关。 */
export function decomposeCommand(cmd: string): string[] {
  if (/[$`]|\beval\b|\bxargs\b|\s-c\s/.test(cmd)) return [];
  return cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter((s) => s !== "");
}

/** unanalyzable 补集检测（kimi 方案——调研底稿 §3）：AST 判定放行的三类展开符（$/反引号/通配符）。
 *  融入 dangerousGate 的 unanalyzable 三态（复用 memoryKey=null 面板退化）——不另起检测链。 */
export function isUnanalyzable(cmd: string): boolean {
  return /[$`]|\*(?!\})|\[(?![\d])/.test(cmd) || /\beval\b|\bxargs\b|\s-c\s/.test(cmd);
}
