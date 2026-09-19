/** markdown 第 1 层渲染（M4-2 T13/B11）——零依赖，仅回显/历史面。
 *  五种形态：代码块缩进+语言/列表圆点/标题下划线/粗体剥离/行内码剥离。
 *  流式期间原样输出（清屏重绘需 raw-mode，CUI 第 2 层）。 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];

  for (const line of lines) {
    const fence = /^```(\w*)/.exec(line);
    if (fence !== null) {
      if (inCode) {
        out.push(`  [${codeLang}] ${codeLines[0] ?? ""}`);
        for (let i = 1; i < codeLines.length; i++) out.push(`  ${codeLines[i]}`);
        inCode = false; codeLines = [];
      } else {
        inCode = true; codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    const h1 = /^# (.+)/.exec(line);
    if (h1 !== null) { out.push(h1[1]!.toUpperCase(), "=".repeat(h1[1]!.length)); continue; }
    const h2 = /^## (.+)/.exec(line);
    if (h2 !== null) { out.push(h2[1]!, "-".repeat(h2[1]!.length)); continue; }

    const ul = /^[-*] (.+)/.exec(line);
    if (ul !== null) { out.push(`• ${ul[1]}`); continue; }

    // 行内剥离（粗体/行内码——保内容去符号）
    out.push(line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"));
  }
  if (inCode) for (const l of codeLines) out.push(l); // 未闭合防御
  return out.join("\n");
}
