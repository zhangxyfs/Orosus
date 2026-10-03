import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AT_PATH_BOUNDARY_SRC } from "./tui/fullapp-at.ts";

/** @文件引用（M4-2 T18/B18）+ 行范围引用（TUI 批 T6/B18 收尾）+ 中文紧贴边界放宽（m5-at-menu T4/D14）：
 *  `@path` 整文件、`@path#L10` / `@path#L10-L20` / `@path#L10-20` 区间附着（越界钳制到行数；空区间带内提示跳过）。
 *  边界判定（2026-10-03 拍板 D14）：@ 前一字符不是路径合法字符即算引用起点（负向后顾——行首/空白/
 *  中文紧贴 `看下@src/a.ts` 全命中；`foo@bar.com` 邮箱 @ 前是 o 不算）。字符集与菜单触发侧同源
 *  （fullapp-at.ts AT_PATH_BOUNDARY_SRC 单一事实源——两侧永不漂移；动集合 = 两侧同动 + 全测重跑）。
 *  正则非贪婪 + lookahead——`#` 不进路径组；`@路径#非L后缀`（如 @p#x）整体不匹配、原文按普通文本
 *  透传（v1.6 行为变化注记：旧正则把 p#x 整段当路径报「文件不存在」——不是引用就不动它，更符合直觉）。
 *  引用移除 = 整匹配删除（从 @ 起——负向后顾不消费边界字符；含 #L 尾巴——v1.8 注记：旧 `replace(\`@${path}\`)`
 *  会把 #L 后缀残留在正文），且按匹配位置删（CR-03：`replace(fullRef)` 删的是全文首个出现，「看
 *  x@rows.txt 和 @rows.txt」会误啃非引用的 x@ 片段、真引用残留——多引用从后往前套删，索引不漂移）。
 *  限制：最多 5 个 / 单文件 50KB（设计空白登记）；不存在/超限 → 跳过+提示（原文引用保留）。 */
export function resolveAtRefs(text: string, cwd: string): { text: string; attachments: string[] } {
  const atRefs = [...text.matchAll(new RegExp(`(?<![${AT_PATH_BOUNDARY_SRC}])@([^\\s#]+?)(?:#L(\\d+)(?:-L?(\\d+))?)?(?=\\s|$)`, "g"))];
  if (atRefs.length === 0) return { text, attachments: [] };
  const attachments: string[] = [];
  // CR-03：真引用的删除区间（按 matchAll 的匹配位置，非字符串首次出现）——从后往前套删
  const removals: { start: number; end: number }[] = [];
  for (const m of atRefs.slice(0, 5)) { // 限 5 个
    const [, path, startRaw, endRaw] = m;
    const fullRef = m[0]; // 整匹配从 @ 起（负向后顾不消费边界字符）——标注与移除同源
    const refStart = m.index; // fullRef 起点 = 匹配起点（边界字符不进匹配——中文紧贴「下」字不会被误删）
    const abs = resolve(cwd, path!);
    try {
      const size = statSync(abs).size;
      if (size > 50 * 1024) {
        attachments.push(`[@${path} 文件过大（${Math.round(size / 1024)}KB > 50KB）——已跳过]`);
        continue;
      }
      const content = readFileSync(abs, "utf8");
      if (startRaw !== undefined) {
        const start = Number(startRaw);
        const end = endRaw !== undefined ? Number(endRaw) : start;
        if (end < start) {
          attachments.push(`[${fullRef} 行范围为空（起点大于终点）——已跳过]`);
          continue;
        }
        const lines = content.split("\n");
        const s = Math.min(Math.max(1, start), lines.length); // 越界钳制到行数
        const e = Math.min(Math.max(s, end), lines.length);
        attachments.push(`[${fullRef}]\n${lines.slice(s - 1, e).join("\n")}`);
      } else {
        attachments.push(`[@${path}]\n${content}`);
      }
      // CR-03：登记真引用的精确区间（整匹配删除——#L 尾巴一并移除），循环后按位置套删——
      // 旧 text.replace(fullRef, "") 删的是 fullRef 在全文中的首个出现：「看 x@rows.txt 和 @rows.txt」
      // 命中 x@rows.txt 里的同串 → 非引用文本被啃、真引用残留正文（附件已附着则语义重复）
      removals.push({ start: refStart, end: m.index + m[0].length });
    } catch {
      attachments.push(`[@${path} 文件不存在——已跳过]`);
    }
  }
  // CR-03：从后往前删——后面的删除不影响前面匹配的索引（正文顺序遍历、逆序套删）
  for (let i = removals.length - 1; i >= 0; i--) {
    const r = removals[i]!;
    text = text.slice(0, r.start) + text.slice(r.end);
  }
  return { text, attachments };
}
