import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** @文件引用（M4-2 T18/B18）：正则扫描 → 读文件 → 附着文本；引用从原文本移除。
 *  限制：最多 5 个 / 单文件 50KB（设计空白登记）；不存在/超限 → 跳过+提示。 */
export function resolveAtRefs(text: string, cwd: string): { text: string; attachments: string[] } {
  const atRefs = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)];
  if (atRefs.length === 0) return { text, attachments: [] };
  const attachments: string[] = [];
  for (const [, path] of atRefs.slice(0, 5)) { // 限 5 个
    const abs = resolve(cwd, path!);
    try {
      const size = statSync(abs).size;
      if (size > 50 * 1024) {
        attachments.push(`[@${path} 文件过大（${Math.round(size / 1024)}KB > 50KB）——已跳过]`);
        continue;
      }
      const content = readFileSync(abs, "utf8");
      attachments.push(`[@${path}]\n${content}`);
      text = text.replace(`@${path}`, ""); // 从原文本移除引用
    } catch {
      attachments.push(`[@${path} 文件不存在——已跳过]`);
    }
  }
  return { text, attachments };
}
