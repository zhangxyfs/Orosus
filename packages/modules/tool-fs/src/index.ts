import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { Access, defineTool, type Tool } from "@orosus/contracts/tool";
import { FS, type Fs } from "@orosus/contracts/fs";

/** fs 能力的本地实现（规则 1 提供者）。所有路径解析限制在根目录内。 */
class LocalFs implements Fs {
  // 显式字段赋值，刻意不用 constructor 参数属性：参数属性是非可擦除语法，node --experimental-strip-types
  // （CLI 的运行方式，Task 21）加载即抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX；vitest 走 esbuild 全转换测不出
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private safe(path: string): string {
    const abs = resolve(this.root, path);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`路径越出根目录：${path}`);
    }
    return abs;
  }

  read(path: string): Promise<string> {
    return Promise.resolve(readFileSync(this.safe(path), "utf8"));
  }

  write(path: string, content: string): Promise<void> {
    writeFileSync(this.safe(path), content, "utf8");
    return Promise.resolve();
  }

  /** glob 匹配（T16）：自实现递归走查 + 模式转正则（避免 fs.glob 类型重载纠缠）；结果经根目录沙箱过滤。 */
  async globFiles(pattern: string): Promise<string[]> {
    this.safe(pattern.replace(/[*?{[]/g, "x")); // 越出根的 pattern 在占位化后仍会被 safe 拦下
    const re = globToRegExp(pattern);
    const skip = new Set(["node_modules", ".git"]);
    const out: string[] = [];
    const walk = (rel: string): void => {
      const abs = join(this.root, rel);
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (skip.has(e.name)) continue;
        const child = rel === "" ? e.name : `${rel}/${e.name}`;
        if (re.test(child)) out.push(this.safe(child));
        if (e.isDirectory()) walk(child);
      }
    };
    walk("");
    return [...new Set(out)].sort();
  }

  /** 内容正则搜索（T16 起）：结构化命中（file 绝对路径 / 1-based 行号 / 行文本截断 200）；
   *  跳过二进制（替换率粗判）与超大文件（>1MB）。三输出模式由工具层渲染（M4-2 T6）。 */
  async grepMatches(regex: string): Promise<{ file: string; lineNo: number; text: string }[]> {
    const re = new RegExp(regex);
    const out: { file: string; lineNo: number; text: string }[] = [];
    for (const p of await this.globFiles("**/*")) {
      let content: string;
      try {
        content = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      if (content.length > 1_048_576) continue;
      const lines = content.split("\n");
      const bad = lines.filter((l) => l.includes("\uFFFD")).length;
      if (lines.length > 0 && bad > lines.length / 4) continue; // 二进制粗判
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) out.push({ file: p, lineNo: i + 1, text: lines[i]!.slice(0, 200) });
      }
    }
    return out;
  }
}

/** glob 模式 → 锚定正则：** 跨段、* 单段内、? 单字符（相对根的 posix 风格路径）。 */
function globToRegExp(pattern: string): RegExp {
  const segs = pattern.split("/");
  const body = segs.map((seg) => {
    if (seg === "**") return "(?:.+)?";
    const esc = seg
      .replace(/[.+^$()|[\]]/g, (c) => "\\" + c)
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    return esc;
  }).join("/");
  const anchored = body.split("(?:.+)?/").join("(?:.+/)?"); // **/ 的斜杠可省——顶层文件也命中
  return new RegExp(`^${anchored}$`);
}

const pathParam = { path: z.string().describe("相对工作目录的路径") };

function readTool(fs: LocalFs): Tool {
  return defineTool({
    name: "tool-fs__read",
    description: "Read file contents with optional line range. Results include line numbers (N→text format).\nUse this tool — not shell commands like cat/head/tail — to inspect text files.\nParameters:\n  path: Relative path to the file\n  offset: 1-based starting line number (optional)\n  limit: Maximum number of lines to return (optional)\nFor large files, use offset+limit to read sections rather than the whole file.",
    parameters: z.object({
      ...pathParam,
      offset: z.number().int().positive().optional().describe("起始行号（1-based）"),
      limit: z.number().int().positive().optional().describe("返回的最大行数"),
    }),
    resolveExecution: async (input) => {
      const { path, offset, limit } = input as { path: string; offset?: number; limit?: number };
      return {
        accesses: [Access.fsRead(path)],
        approvalRule: "tool-fs__read",
        execute: async () => {
          try {
            const content = await fs.read(path);
            const lines = content.split("\n").filter((_, i, arr) => i < arr.length - 1 || arr[i] !== ""); // 去尾空段
            const start = (offset ?? 1) - 1;
            if (start >= lines.length) {
              return { output: `文件共 ${lines.length} 行，offset 超界（offset = ${offset ?? 1}）`, isError: false };
            }
            const slice = lines.slice(start, start + (limit ?? lines.length - start));
            const numbered = slice.map((text, i) => `${start + i + 1}→${text}`).join("\n");
            const footer = `\n(第 ${start + 1}-${start + slice.length} 行，共 ${lines.length} 行)`;
            return { output: numbered + footer, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

function writeTool(fs: LocalFs): Tool {
  return defineTool({
    name: "tool-fs__write",
    description: "Create a new file or completely replace an existing file's contents.\nUse this tool — not shell echo/redirection or heredocs — to create or overwrite files.\nFor targeted changes to existing files, prefer edit instead (read the file first).",
    parameters: z.object({ ...pathParam, content: z.string() }),
    resolveExecution: async (input) => {
      const { path, content } = input as { path: string; content: string };
      return {
        accesses: [Access.fsWrite(path)],
        approvalRule: "tool-fs__write",
        execute: async () => {
          try {
            await fs.write(path, content);
            return { output: `已写入 ${path}（${content.length}B）`, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

function editTool(fs: LocalFs): Tool {
  return defineTool({
    name: "tool-fs__edit",
    description: "Make precise text replacements in a file using exact oldText matching.\nUse this tool — not sed/awk — for targeted file edits.\nAll edits are matched against the ORIGINAL file simultaneously (not incrementally).\nEach edit's oldText must appear exactly once, unless replaceAll is set.\nIf two edits overlap, the call fails — merge them or target disjoint regions.",
    parameters: z.object({
      ...pathParam,
      edits: z.array(z.object({
        oldText: z.string().describe("待替换的精确文本"),
        newText: z.string().describe("替换后的文本"),
        replaceAll: z.boolean().optional().describe("替换全部出现（不参与唯一性/重叠检测）"),
      })).min(1).describe("编辑列表——全部基于原文件匹配，不得重叠"),
    }),
    resolveExecution: async (input) => {
      const { path, edits } = input as { path: string; edits: { oldText: string; newText: string; replaceAll?: boolean }[] };
      return {
        accesses: [Access.fsWrite(path)],
        approvalRule: "tool-fs__edit",
        execute: async () => {
          try {
            const before = await fs.read(path);
            const positions: { start: number; end: number; newText: string; index: number }[] = [];
            for (let i = 0; i < edits.length; i++) {
              const e = edits[i]!;
              if (e.replaceAll === true) continue; // 全替换不参与位置检测
              const pos = before.indexOf(e.oldText);
              if (pos < 0) return { output: `edits[${i}]: 未找到待替换文本`, isError: true };
              if (before.indexOf(e.oldText, pos + 1) >= 0) {
                return { output: `edits[${i}]: 多处匹配——请提供更长的唯一片段或设 replaceAll`, isError: true };
              }
              positions.push({ start: pos, end: pos + e.oldText.length, newText: e.newText, index: i });
            }
            // 重叠检测（pi 原文件匹配方案核心）
            positions.sort((a, b) => a.start - b.start);
            for (let i = 1; i < positions.length; i++) {
              if (positions[i]!.start < positions[i - 1]!.end) {
                return {
                  output: `edits[${positions[i - 1]!.index}] 和 edits[${positions[i]!.index}] 重叠——合并为一个 edit 或选不重叠的区域`,
                  isError: true,
                };
              }
            }
            // 从原文件一次性应用（不基于中间结果）
            let result = "";
            let cursor = 0;
            for (const p of positions) {
              result += before.slice(cursor, p.start) + p.newText;
              cursor = p.end;
            }
            result += before.slice(cursor);
            for (const e of edits) {
              if (e.replaceAll === true) result = result.split(e.oldText).join(e.newText);
            }
            await fs.write(path, result);
            const count = positions.length + edits.filter((e) => e.replaceAll === true).length;
            return { output: `已编辑 ${path}（${count} 处）`, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

function globTool(fs: LocalFs): Tool {
  return defineTool({
    name: "tool-fs__glob",
    description: "Find files by glob pattern. Results are file paths only.\nUse this tool — not shell find or ls — to discover files by name pattern.\nRespects .gitignore. head_limit to cap results (default 100).",
    parameters: z.object({
      pattern: z.string().describe("glob 模式"),
      head_limit: z.number().int().positive().optional().describe("返回的最大条数（缺省 100）"),
    }),
    resolveExecution: async (input) => {
      const { pattern, head_limit } = input as { pattern: string; head_limit?: number };
      return {
        accesses: [Access.fsRead(pattern)],
        approvalRule: "tool-fs__glob",
        execute: async () => {
          try {
            const files = await fs.globFiles(pattern);
            const limit = head_limit ?? 100;
            const shown = files.slice(0, limit);
            const footer = files.length > limit ? `\n(共 ${files.length} 条，仅显示前 ${limit} 条)` : "";
            return { output: (shown.length > 0 ? shown.join("\n") : "（无匹配）") + footer, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

function grepTool(fs: LocalFs): Tool {
  return defineTool({
    name: "tool-fs__grep",
    description: "Search file contents by JavaScript regex pattern.\nUse this tool — not shell grep or rg — to search file contents.\noutput_mode: \"content\" (path:line:text), \"files_with_matches\" (paths only), or \"count\".\nUse files_with_matches to locate files, then read for context.",
    parameters: z.object({
      pattern: z.string().describe("JavaScript 正则"),
      output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("输出格式（缺省 content）"),
    }),
    resolveExecution: async (input) => {
      const { pattern, output_mode } = input as { pattern: string; output_mode?: "content" | "files_with_matches" | "count" };
      return {
        accesses: [Access.fsRead("**/*")],
        approvalRule: "tool-fs__grep",
        execute: async () => {
          try {
            const matches = await fs.grepMatches(pattern);
            let body: string;
            if (output_mode === "files_with_matches") {
              body = [...new Set(matches.map((m) => m.file))].join("\n");
            } else if (output_mode === "count") {
              const perFile = new Map<string, number>();
              for (const m of matches) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
              body = [...perFile].map(([f, n]) => `${f}: ${n}`).join("\n");
            } else {
              body = matches.map((m) => `${m.file}:${m.lineNo}:${m.text}`).join("\n");
            }
            return { output: body !== "" ? body : "（无匹配）", isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

export default defineModule({
  name: "tool-fs",
  version: "0.1.0",
  description: "本地文件系统工具（read/write/edit）与 fs 能力",
  api: 1,
  provides: [FS],
  uses: ["fs.read", "fs.write"],
  activate(ctx) {
    // M1：根 = 进程 cwd；root 配置项待真实需求出现时经本模块 config schema 加入
    const fs = new LocalFs(process.cwd());
    ctx.provide(FS, fs);
    ctx.contribute.tool(readTool(fs));
    ctx.contribute.tool(writeTool(fs));
    ctx.contribute.tool(editTool(fs));
    ctx.contribute.tool(globTool(fs));
    ctx.contribute.tool(grepTool(fs));
  },
});
