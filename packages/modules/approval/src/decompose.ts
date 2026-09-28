import { NESTED_SHELLS, normalizeCommandName } from "./dangerous.ts";

/** bash 复合命令分段（Reasonix bash_decompose 参照——调研底稿 §4）。
 *  按顶层 ;/&&/||/| 拆段、返回各段**完整文本**。含 eval/xargs/嵌套 shell -c/$/反引号 → 返回 []
 *  （= require-human，不可自动记规则）。
 *  MA-02/03 修复（2026-09-28 code review）：不再把段截断成「前两词」（npm run 三词特例随之退役）——
 *  匹配一律对完整段文本做：旧截断使 `bash(git push *)` 这类 ≥2 词前缀规则永不命中（deny 拦不住），
 *  而 `bash(npm test)` 精确规则反而误吞 `npm test --watch`。规则生成只取首词（index.ts split(" ")[0]），
 *  与段长无关。
 *  MA-07 修复（2026-09-28 code review）：`\s-c\s` 语境化——旧正则无命令名语境，`gcc -c foo.c`、
 *  `clang -c`、`git -c <配置覆盖>`（MA-06 同款误伤）等良性形态全被当成不可分段/不可分析，
 *  永久两选询问且不可记忆；现仅嵌套 shell 命令名后的 -c 才判不可分段（AST 层 dangerous.ts
 *  本就按命令名递归载荷，正则补集对齐其口径）。 */
export function decomposeCommand(cmd: string): string[] {
  if (/[$`]|\beval\b|\bxargs\b/.test(cmd) || hasNestedShellDashC(cmd)) return [];
  return cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter((s) => s !== "");
}

/** unanalyzable 补集检测（kimi 方案——调研底稿 §3）：AST 判定放行的三类展开符（$/反引号/通配符）。
 *  融入 dangerousGate 的 unanalyzable 三态（复用 memoryKey=null 面板退化）——不另起检测链。
 *  MA-07：-c 同样限定嵌套 shell 语境（见 decomposeCommand 头注释）。 */
export function isUnanalyzable(cmd: string): boolean {
  return /[$`]|\*(?!\})|\[(?![\d])/.test(cmd) || /\beval\b|\bxargs\b/.test(cmd) || hasNestedShellDashC(cmd);
}

/** 嵌套 shell 的 `-c` 形态检测（MA-07）：shell 名（剥路径/.exe、小写——与 AST normalizeCommandName 同源，
 *  包装器前缀 sudo/env/nohup 等天然不影响——判定的是 -c 前一个 token）后跟短选项簇（`-c`/`-xc`——
 *  includes("c") 与 AST 嵌套 shell 分支同款）即视为嵌套 shell 载荷。长选项（--rcfile 等）会终止
 *  选项簇扫描——与 AST 分支 break 行为一致。 */
function hasNestedShellDashC(cmd: string): boolean {
  const tokens = cmd.split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!NESTED_SHELLS.has(normalizeCommandName(tokens[i]!))) continue;
    for (let j = i + 1; j < tokens.length && /^-[a-zA-Z]+$/.test(tokens[j]!); j += 1) {
      if (tokens[j]!.includes("c")) return true;
    }
  }
  return false;
}
