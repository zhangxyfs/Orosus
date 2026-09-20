import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** @文件引用（M4-2 T18/B18）+ 行范围引用（TUI 批 T6/B18 收尾）：`@path` 整文件、
 *  `@path#L10` / `@path#L10-L20` / `@path#L10-20` 区间附着（越界钳制到行数；空区间带内提示跳过）。
 *  正则非贪婪 + lookahead——`#` 不进路径组；`@路径#非L后缀`（如 @p#x）整体不匹配、原文按普通文本
 *  透传（v1.6 行为变化注记：旧正则把 p#x 整段当路径报「文件不存在」——不是引用就不动它，更符合直觉）。
 *  引用移除 = 整匹配删除（含 #L 尾巴——v1.8 注记：旧 `replace(\`@${path}\`)` 会把 #L 后缀残留在正文）。
 *  限制：最多 5 个 / 单文件 50KB（设计空白登记）；不存在/超限 → 跳过+提示（原文引用保留）。 */
export function resolveAtRefs(text: string, cwd: string): { text: string; attachments: string[] } {
  const atRefs = [...text.matchAll(/(?:^|\s)@([^\s#]+?)(?:#L(\d+)(?:-L?(\d+))?)?(?=\s|$)/g)];
  if (atRefs.length === 0) return { text, attachments: [] };
  const attachments: string[] = [];
  for (const m of atRefs.slice(0, 5)) { // 限 5 个
    const [, path, startRaw, endRaw] = m;
    const fullRef = m[0].replace(/^\s/, ""); // 整匹配（去边界空白）——标注与移除同源
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
      text = text.replace(fullRef, ""); // 整匹配删除——#L 尾巴一并移除
    } catch {
      attachments.push(`[@${path} 文件不存在——已跳过]`);
    }
  }
  return { text, attachments };
}
