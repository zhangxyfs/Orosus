import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.ts";

describe("renderMarkdown 第 1 层（M4-2 T13/B11）", () => {
  it("① 代码块围栏 → 缩进+语言标注", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\nconst y = 2;\n```");
    expect(out).toContain("  [ts] const x = 1;");
    expect(out).toContain("  const y = 2;");
  });

  it("② 无序列表 → 圆点；有序保留", () => {
    expect(renderMarkdown("- item1\n- item2")).toContain("• item1");
    expect(renderMarkdown("1. first\n2. second")).toContain("1. first");
  });

  it("③ 标题 H1 → 大写+===；H2 → ---", () => {
    expect(renderMarkdown("# Hello")).toContain("HELLO\n===");
    expect(renderMarkdown("## World")).toContain("World\n---");
  });

  it("④ 行内 **bold** → 剥离；`code` → 剥离", () => {
    expect(renderMarkdown("This is **bold** text")).toContain("This is bold text");
    expect(renderMarkdown("Use `npm install`")).toContain("Use npm install");
  });

  it("⑤ 未闭合代码块 → 剩余行原样", () => {
    const out = renderMarkdown("```ts\nconst x = 1;"); // 没有闭围栏
    expect(out).toContain("const x = 1;");
  });
});
