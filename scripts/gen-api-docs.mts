/** API 参考生成（§11.10，m5 后重写）：从 contracts 源直接生成**给人看的** Markdown 到 docs/api/
 *  （typedoc HTML 形态 2026-09-25 废弃——「Defined in」烤 HEAD sha 每提交必漂移，且树状跳转页不可线性阅读）。
 *
 *  fail-loud 完整性门禁（比 extension-catalog 更严——API 参考是契约的门面）：
 *  ① 每个 export 必须有文档注释；
 *  ② 每个带参函数/方法必须逐参数有 @param（含义 + 范围/缺省——缺哪个点名哪个）；
 *  ③ module 域（模块开发者主界面）的函数/接口导出必须有 @example。
 *  任一不过 → 非零退出，宁可不渲染也不给读者一个没说清的口。
 *
 *  可导入形态供测试（tests/api-docs.test.ts）：parseDoc / parseContractFile / buildApiDocs 纯函数。 */

import { readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export interface DomainSpec {
  /** 域名（输出件名与标题）。 */
  name: string;
  /** 源文件（相对仓库根）。 */
  file: string;
  /** 一句人话定位（索引页与域首页导语）。 */
  blurb: string;
  /** module 域强制 @example（模块开发者主界面）。 */
  requireExample?: boolean;
}

export const DOMAINS: DomainSpec[] = [
  { name: "module", file: "packages/contracts/src/module/index.ts", blurb: "模块 API 主面——defineModule、ModuleContext 全口（工具/命令/提示词段/卡片）、CommandUi 交互（弹窗/控件窗/注入）、LlmPort、SettingsService 与 HostInfo 读面、事件与信任门语义。", requireExample: true },
  { name: "tool", file: "packages/contracts/src/tool/index.ts", blurb: "工具契约——defineTool 两阶段（resolveExecution 声明 / execute 副作用）、Access 资源声明、审批规则与结果形状。" },
  { name: "provider", file: "packages/contracts/src/provider/index.ts", blurb: "提供商适配器契约——StreamFn 流式口、消息与工具规格形状、槽位解析辅助。" },
  { name: "fs", file: "packages/contracts/src/fs/index.ts", blurb: "文件系统能力契约（FS 能力槽的接口形状）。" },
  { name: "home", file: "packages/contracts/src/home/index.ts", blurb: "宿主数据目录解析（OROSUS_HOME 覆盖）。" },
];

/** 文档注释块结构：正文段 + 标记段（@param/@returns/@example）。 */
export interface DocComment {
  body: string[];
  params: { name: string; text: string }[];
  returns?: string;
  example?: string;
}

/** 解析文档注释（斜杠星围栏）→ DocComment。 */
export function parseDoc(raw: string): DocComment {
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^\s*\/?\*\*?\/?/, "").replace(/\*\/\s*$/, "").trimEnd())
    .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd());
  const out: DocComment = { body: [], params: [] };
  let inExample = false;
  let exampleLines: string[] = [];
  for (const l of lines) {
    if (!inExample && l.trim() === "@example") {
      inExample = true;
      continue;
    }
    if (inExample) {
      exampleLines.push(l);
      continue;
    }
    const pm = /^\s*@param\s+(\S+)\s*-?\s*(.*)$/.exec(l);
    if (pm !== null) {
      out.params.push({ name: pm[1]!, text: pm[2]! });
      continue;
    }
    const rm = /^\s*@returns\s+-?\s*(.*)$/.exec(l);
    if (rm !== null) {
      out.returns = rm[1]!;
      continue;
    }
    if (/^\s*@/.test(l)) continue; // 其他标记（@internal 等）不进正文
    out.body.push(l);
  }
  if (exampleLines.length > 0) {
    // 去首行围栏与尾围栏，保留代码体；公共缩进 dedent（注释前导 " *  " 剥后残留一格；嵌套示例保相对缩进）
    const firstFence = exampleLines.findIndex((l) => l.includes("```"));
    const rest = firstFence >= 0 ? exampleLines.slice(firstFence + 1) : exampleLines;
    const lastFence = [...rest].reverse().findIndex((l) => l.includes("```"));
    const code0 = lastFence >= 0 ? rest.slice(0, rest.length - lastFence - 1) : rest;
    const nonEmpty = code0.filter((l) => l.trim() !== "");
    const indents = nonEmpty.map((l) => (l.match(/^ */)![0]!).length);
    const dedent = indents.length > 0 ? Math.min(...indents) : 0;
    const code = code0.map((l) => (l.trim() === "" ? "" : l.slice(dedent)));
    out.example = code.join("\n").trim();
  }
  return out;
}

export type SymKind = "function" | "interface" | "type" | "const" | "class";

export interface MemberDoc {
  name: string;
  optional: boolean;
  typeText: string;
  params: string[]; // 方法参数名（方法形态）
  doc?: DocComment | undefined;
}

export interface SymbolDoc {
  name: string;
  kind: SymKind;
  signature: string; // 声明首行（人可读形态）
  doc: DocComment;
  members: MemberDoc[]; // interface 成员
}

/** 解析契约源文件 → 顶层 export 清单（doc/成员/签名）。 */
export function parseContractFile(source: string): SymbolDoc[] {
  const out: SymbolDoc[] = [];
  const declRe = /^export (?:async )?(function|interface|type|const|class)\s+(\w+)(<[^>]*>)?/gm;
  for (let m = declRe.exec(source); m !== null; m = declRe.exec(source)) {
    const kind = m[1] as SymKind;
    const name = m[2]!;
    const declStart = m.index;
    const before = source.slice(0, declStart);
    const dEnd = before.lastIndexOf("*/");
    const dStart = dEnd >= 0 ? before.lastIndexOf("/**", dEnd) : -1;
    let doc: DocComment | undefined;
    if (dStart >= 0 && source.slice(dEnd + 2, declStart).trim() === "") {
      doc = parseDoc(source.slice(dStart, dEnd + 2));
    }
    const lineEnd = source.indexOf("\n", declStart);
    const signature = source.slice(declStart, lineEnd).trim();
    const members: MemberDoc[] = [];
    if (kind === "interface") {
      const bodyStart = source.indexOf("{", declStart);
      let depth = 0;
      let bodyEnd = source.length;
      for (let i = bodyStart; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) {
            bodyEnd = i;
            break;
          }
        }
      }
      const body = source.slice(bodyStart + 1, bodyEnd);
      const lineRe = /^ {2}(?:readonly )?(\w+)(\?)?\s*[:(]/gm;
      for (let lm = lineRe.exec(body); lm !== null; lm = lineRe.exec(body)) {
        const mName = lm[1]!;
        if (mName === "get" || mName === "set") continue;
        const mOpt = lm[2] === "?";
        const mDeclStart = lm.index;
        const mLineEnd = body.indexOf("\n", mDeclStart);
        const mLine = body.slice(mDeclStart, mLineEnd >= 0 ? mLineEnd : undefined);
        const mBefore = body.slice(0, mDeclStart);
        const mDEnd = mBefore.lastIndexOf("*/");
        const mDStart = mDEnd >= 0 ? mBefore.lastIndexOf("/**", mDEnd) : -1;
        let mDoc: DocComment | undefined;
        if (mDStart >= 0 && body.slice(mDEnd + 2, mDeclStart).trim() === "") {
          mDoc = parseDoc(body.slice(mDStart, mDEnd + 2));
        } else {
          const trail = /\/\/\s*(.+)$/.exec(mLine);
          if (trail !== null) mDoc = { body: [trail[1]!], params: [] };
        }
        // 参数提取三形态：方法 name(params): ret（括号配平取参）；属性式函数 name?: ((params) => ret)
        // 或 name?: (params) => ret；多行签名/泛型内逗号按深度分割（顶层逗号才分行）
        let params: string[] = [];
        const nameM = /^ {2}(?:readonly )?(\w+)\??/.exec(mLine);
        if (nameM !== null) {
          const afterName = mLine.slice(nameM[0].length);
          let raw: string | undefined;
          if (afterName.startsWith("(")) {
            // 方法形态：首个括号配平
            let d = 0;
            let e = -1;
            for (let ci = 0; ci < afterName.length; ci++) {
              const ch = afterName[ci]!;
              if (ch === "(" || ch === "{" || ch === "<") d++;
              else if (ch === ")" || ch === "}" || ch === ">") {
                d--;
                if (d === 0 && ch === ")") {
                  e = ci;
                  break;
                }
              }
            }
            if (e > 0) raw = afterName.slice(1, e);
          } else if (afterName.startsWith(":")) {
            const t = afterName.slice(1).trim();
            const fn2 = /^\(\(([^)]*)\)/.exec(t);
            const fn1 = /^\(([^)]*)\)\s*=>/.exec(t);
            raw = fn2?.[1] ?? fn1?.[1];
          }
          if (raw !== undefined && raw.trim() !== "") {
            // 顶层逗号分割（跟踪 {} <> 深度）
            const segs: string[] = [];
            let depth = 0;
            let cur = "";
            for (const ch of raw) {
              if (ch === "{" || ch === "<" || ch === "[") depth++;
              else if (ch === "}" || ch === ">" || ch === "]") depth--;
              if (ch === "," && depth === 0) {
                segs.push(cur);
                cur = "";
              } else cur += ch;
            }
            if (cur.trim() !== "") segs.push(cur);
            params = segs
              .map((x) => x.trim().split(/[:\s=]/)[0]!.replace(/^\.\.\./, "").replace(/\?$/, ""))
              .filter((x) => x !== "");
          }
        }
        const typeText = mLine.replace(/\/\/.*$/, "").replace(/[,;]\s*$/, "").trim();
        members.push({ name: mName, optional: mOpt, typeText, params, doc: mDoc });
      }
    }
    out.push({ name, kind, signature, doc: doc ?? { body: [], params: [] }, members });
  }
  return out;
}

const kindText: Record<SymKind, string> = { function: "函数", interface: "接口", type: "类型", const: "常量", class: "类" };

const escapePipe = (s: string): string => s.replace(/\|/g, "\\|");

/** 完整性校验（fail-loud 的工作面）：返回问题清单。 */
export function auditSymbols(syms: SymbolDoc[], domain: DomainSpec): string[] {
  const problems: string[] = [];
  for (const s of syms) {
    if (s.doc.body.length === 0 && s.doc.example === undefined) {
      problems.push(`${domain.name}/${s.name}：没有文档注释`);
      continue;
    }
    const checkParams = (label: string, params: string[], doc: DocComment): void => {
      const documented = new Set(doc.params.map((p) => p.name));
      for (const p of params) {
        if (!documented.has(p)) problems.push(`${domain.name}/${label}：参数 "${p}" 缺 @param（含义+范围）`);
      }
    };
    if (s.kind === "function") {
      const fp = s.signature.slice(s.signature.indexOf("(") + 1, s.signature.lastIndexOf(")"));
      const params = fp.split(",").map((p) => p.trim().split(/[:\s=]/)[0]!.replace(/^\.\.\./, "")).filter((p) => p !== "");
      checkParams(s.name, params, s.doc);
    }
    for (const mem of s.members) {
      if (mem.params.length > 0 && mem.doc !== undefined) {
        checkParams(`${s.name}.${mem.name}`, mem.params, mem.doc);
      } else if (mem.params.length > 0 && mem.doc === undefined) {
        problems.push(`${domain.name}/${s.name}.${mem.name}：方法没有文档注释（参数无从谈起）`);
      }
      if (mem.doc === undefined && domain.name === "module") {
        problems.push(`${domain.name}/${s.name}.${mem.name}：成员缺注释`);
      }
    }
    if (domain.requireExample === true && (s.kind === "function" || s.kind === "interface") && s.doc.example === undefined) {
      problems.push(`${domain.name}/${s.name}：缺 @example`);
    }
  }
  return problems;
}

/** 单域渲染：Markdown 参考页。 */
export function renderDomain(domain: DomainSpec, syms: SymbolDoc[]): string {
  const parts: string[] = [
    `# ${domain.name} 域 API 参考`,
    "",
    `> ${domain.blurb}`,
    "> 本文件由 `scripts/gen-api-docs.mts` 从 contracts 源生成（`pnpm gen-docs`，docs:check 门禁验同步）——",
    "> 注释、@param（含义+范围）、@example 与源码同源；发现缺口门禁会红。",
    "",
  ];
  for (const s of syms) {
    parts.push(`## ${s.name}（${kindText[s.kind]}）`, "");
    const body = s.doc.body.map((x) => x.trim()).filter((x) => x !== "");
    if (body.length > 0) parts.push(body.join("\n"), "");
    const sig0 = s.signature.replace(/;\s*$/, "");
    const sig = sig0.endsWith("{") && s.kind === "interface" ? `${sig0.slice(0, -1).trimEnd()} { … }` : sig0.replace(/\{$/, "").trimEnd();
    parts.push("```ts", sig + (s.kind === "function" ? ";" : ""), "```", "");
    if (s.kind === "function" && s.doc.params.length > 0) {
      parts.push("**参数**", "", "| 名 | 说明 |", "|---|---|");
      for (const p of s.doc.params) parts.push(`| \`${p.name}\` | ${escapePipe(p.text)} |`);
      parts.push("");
    }
    if (s.members.length > 0) {
      parts.push("**成员**", "", "| 名 | 形态 | 说明 |", "|---|---|---|");
      for (const mem of s.members) {
        const desc = mem.doc === undefined ? "" : escapePipe(mem.doc.body.map((x) => x.trim()).filter((x) => x !== "").join(" "));
        parts.push(`| \`${mem.name}${mem.optional ? "?" : ""}\` | \`${escapePipe(mem.typeText)}\` | ${desc} |`);
      }
      const methodParams = s.members.filter((m) => m.params.length > 0 && m.doc !== undefined && m.doc.params.length > 0);
      if (methodParams.length > 0) {
        // 同形参数集折叠（Logger 五法同参表不重复五遍）：参数名+文本完全一致的方法并列一行
        const groups: { methods: string[]; name: string; text: string }[] = [];
        for (const mem of methodParams) {
          for (const p of mem.doc!.params) {
            const hit = groups.find((g) => g.name === p.name && g.text === p.text);
            if (hit !== undefined) {
              if (!hit.methods.includes(mem.name)) hit.methods.push(mem.name);
            } else groups.push({ methods: [mem.name], name: p.name, text: p.text });
          }
        }
        parts.push("", "**方法参数**", "", "| 方法 | 参 | 说明 |", "|---|---|---|");
        for (const g of groups) {
          parts.push(`| \`${g.methods.join(" · ")}\` | \`${g.name}\` | ${escapePipe(g.text)} |`);
        }
        parts.push("");
      }
    }
    if (s.doc.returns !== undefined) parts.push(`**返回**：${s.doc.returns}`, "");
    if (s.doc.example !== undefined && s.doc.example !== "") {
      parts.push("**示例**", "", "```ts", s.doc.example, "```", "");
    }
  }
  return parts.join("\n");
}

export interface BuildResult {
  files: { path: string; content: string }[];
  symbols: number;
}

/** 全量构建（纯函数）：五域 + 索引页。任一域审计不过 → 抛错（fail-loud）。 */
export function buildApiDocs(read: (p: string) => string): BuildResult {
  const problems: string[] = [];
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const d of DOMAINS) {
    const syms = parseContractFile(read(d.file));
    total += syms.length;
    problems.push(...auditSymbols(syms, d));
    files.push({ path: `docs/api/${d.name}.md`, content: renderDomain(d, syms) });
  }
  if (problems.length > 0) {
    throw new Error(`API 参考 fail-loud（缺注释/缺 @param/缺 @example）：\n${problems.join("\n")}`);
  }
  const index = [
    "# Orosus contracts API 参考（机器生成——勿手改）",
    "",
    "> 给模块开发者看的完整接口参考：每个导出的含义、参数（含范围与缺省）、返回与示例，",
    "> 与 `packages/contracts/src/*/index.ts` 的注释同源生成（`pnpm gen-docs`；docs:check 门禁验同步）。",
    "> 快速上手看 [module-walkthrough.md](../module-walkthrough.md)；帮人写模块的 AI 先读 [extension-catalog.md](../extension-catalog.md)。",
    "",
    "| 域 | 内容 | 文件 |",
    "|---|---|---|",
    ...DOMAINS.map((d) => `| ${d.name} | ${d.blurb} | [${d.name}.md](${d.name}.md) |`),
    "",
  ].join("\n");
  files.unshift({ path: "docs/api/README.md", content: index });
  return { files, symbols: total };
}

// ---- 脚本入口（测试 import 时不执行） ----
const selfPath = fileURLToPath(import.meta.url).split("\\").join("/").split("/").pop() ?? "";
const argvPath = (process.argv[1] ?? "").split("\\").join("/").split("/").pop() ?? "";
if (process.env.VITEST === undefined && selfPath === argvPath) {
  const root = join(fileURLToPath(new URL("..", import.meta.url)));
  try {
    const { files, symbols } = buildApiDocs((p) => readFileSync(join(root, p), "utf8"));
    // 清掉 typedoc 时代的 HTML 产物（之后目录里只剩新生成的 markdown）
    const apiDir = join(root, "docs", "api");
    for (const e of readdirSync(apiDir)) {
      if (e.endsWith(".html") || e === "assets") {
        const p = join(apiDir, e);
        if (e === "assets") rmSync(p, { recursive: true, force: true });
        else rmSync(p, { force: true });
      }
    }
    mkdirSync(apiDir, { recursive: true });
    for (const f of files) writeFileSync(join(root, f.path), f.content, "utf8");
    console.log(`docs/api 已生成（${symbols} 个符号，${files.length} 个 markdown 件——typedoc HTML 已废弃清除）`);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
