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

  /** 内容正则搜索（T16）：path:line:text；跳过二进制（替换率粗判）与超大文件（>1MB）。 */
  async grepLines(regex: string): Promise<string[]> {
    const re = new RegExp(regex);
    const out: string[] = [];
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
        if (re.test(lines[i]!)) out.push(`${p}:${i + 1}:${lines[i]!.slice(0, 200)}`);
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
    description: "读取文件全部内容",
    parameters: z.object(pathParam),
    resolveExecution: async (input) => {
      const { path } = input as z.infer<z.ZodObject<typeof pathParam>>;
      return {
        accesses: [Access.fsRead(path)],
        approvalRule: "tool-fs__read",
        execute: async () => {
          try {
            return { output: await fs.read(path), isError: false };
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
    description: "写入文件（覆盖）",
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
    description: "精确替换文件中的唯一文本段",
    parameters: z.object({ ...pathParam, oldText: z.string(), newText: z.string() }),
    resolveExecution: async (input) => {
      const { path, oldText, newText } = input as { path: string; oldText: string; newText: string };
      return {
        accesses: [Access.fsWrite(path)],
        approvalRule: "tool-fs__edit",
        execute: async () => {
          try {
            const before = await fs.read(path);
            const first = before.indexOf(oldText);
            if (first < 0) return { output: `未找到待替换文本（oldText 不匹配）`, isError: true };
            if (before.indexOf(oldText, first + 1) >= 0) {
              return { output: `oldText 在文件中多处匹配，请提供更长的唯一片段`, isError: true };
            }
            await fs.write(path, before.slice(0, first) + newText + before.slice(first + oldText.length));
            return { output: `已编辑 ${path}`, isError: false };
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
    description: "按 glob 模式列出文件（如 **/*.ts），限根目录内",
    parameters: z.object({ pattern: z.string().describe("glob 模式") }),
    resolveExecution: async (input) => {
      const { pattern } = input as { pattern: string };
      return {
        accesses: [Access.fsRead(pattern)],
        approvalRule: "tool-fs__glob",
        execute: async () => {
          try {
            const files = await fs.globFiles(pattern);
            return { output: files.length > 0 ? files.join("\n") : "（无匹配）", isError: false };
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
    description: "内容正则搜索，输出 path:line:text",
    parameters: z.object({ pattern: z.string().describe("JavaScript 正则") }),
    resolveExecution: async (input) => {
      const { pattern } = input as { pattern: string };
      return {
        accesses: [Access.fsRead("**/*")],
        approvalRule: "tool-fs__grep",
        execute: async () => {
          try {
            const lines = await fs.grepLines(pattern);
            return { output: lines.length > 0 ? lines.join("\n") : "（无匹配）", isError: false };
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
