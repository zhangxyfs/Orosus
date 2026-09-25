/** 扩展点目录生成器（m5 T16，候选 A-5）：从 contracts 源生成模型可读的贡献点目录
 *  docs/extension-catalog.md——AI 帮人写模块时先读这份，不用翻文档。
 *
 *  fail-loud 纪律（dsh cordis_inspect 同款）：贡献点缺文档注释或缺 @example 即非零退出——
 *  宁可不渲染，也不给模型一个调不了的口。门禁 = package.json 的 docs:check（生成后 git diff）。
 *
 *  可导入形态供测试（tests/extension-catalog.test.ts）：buildCatalog(source) 纯函数。 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** 目录条目：id = 目录名（人话锚），decl = 源内声明行的匹配正则。 */
export interface CatalogEntry {
  id: string;
  area: "贡献点" | "交互 UI" | "读面与设置" | "基础设施";
  decl: RegExp;
}

/** 贡献点清单（生成器的「契约」——新口子落地必须在此登记 + 契约源带注释与 @example）。 */
export const CATALOG_ENTRIES: CatalogEntry[] = [
  { id: "contribute.tool", area: "贡献点", decl: /^\s*tool\(t: Tool\): Disposer;/m },
  { id: "contribute.command", area: "贡献点", decl: /command\(name: string, handler: CommandHandler, opts\?/ },
  { id: "contribute.promptSection", area: "贡献点", decl: /^\s*promptSection\(s: PromptSection\): Disposer;/m },
  { id: "contribute.configOverlay", area: "贡献点", decl: /^\s*configOverlay\(o: \{/m },
  { id: "contribute.card", area: "贡献点", decl: /^\s*card\?\(spec: CardSpec\): Disposer;/m },
  { id: "ui.notice", area: "交互 UI", decl: /^\s*notice\?\(text: string, opts\?/m },
  { id: "ui.viewText", area: "交互 UI", decl: /^\s*viewText\?\(title: string/m },
  { id: "ui.insertText", area: "交互 UI", decl: /^\s*readonly insertText\?:/m },
  { id: "ui.attachImage", area: "交互 UI", decl: /^\s*readonly attachImage\?:/m },
  { id: "ui.dialog", area: "交互 UI", decl: /^\s*readonly dialog\?:/m },
  { id: "ctx.settings", area: "读面与设置", decl: /^\s*readonly settings\?: SettingsService \| undefined;/m },
  { id: "ctx.host", area: "读面与设置", decl: /^\s*readonly host\?: HostInfo \| undefined;/m },
  { id: "events.on / events.emit", area: "基础设施", decl: /^\s*on\(type: string, listener: Listener\): Disposer;/m },
  { id: "session.append / session.messages", area: "基础设施", decl: /^\s*append\(type: string, payload: Record<string, unknown>\): void;/m },
  { id: "services.get / provide", area: "基础设施", decl: /^\s*provide\(key: string, impl: unknown\): void;/m },
];

/** 取声明行前的文档注释块（斜杠星围栏）——找不到返回 undefined。 */
function docBlockAbove(source: string, declIdx: number): string | undefined {
  const before = source.slice(0, declIdx);
  const end = before.lastIndexOf("*/");
  if (end < 0) return undefined;
  const start = before.lastIndexOf("/**", end);
  if (start < 0) return undefined;
  // 注释块与声明之间只允许空白
  if (source.slice(end + 2, declIdx).trim() !== "") return undefined;
  return source.slice(start, end + 2);
}

/** 注释块 → 人话首句（第一行描述文字）。 */
const firstSentence = (doc: string): string => {
  const lines = doc.split("\n").map((l) => l.replace(/^\s*\/?\*\*?\/?/, "").trim()).filter((l) => l !== "" && !l.startsWith("@"));
  return lines[0] ?? "";
};

/** 注释块 → 首个 @example 的代码体（ts 围栏内）。 */
const exampleOf = (doc: string): string | undefined => {
  const m = /@example\s*\n\s*\*\s*```ts\n([\s\S]*?)\s*\*\s*```/.exec(doc);
  if (m === null) return undefined;
  return m[1]!.split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).join("\n").trim();
};

export interface CatalogResult {
  markdown: string;
  entries: number;
}

/** 生成目录（纯函数）：任一条目缺注释或缺 @example → 抛错（fail-loud——门禁非零退出的底座）。 */
export function buildCatalog(source: string): CatalogResult {
  const sections = new Map<string, string[]>();
  const problems: string[] = [];
  for (const e of CATALOG_ENTRIES) {
    const m = e.decl.exec(source);
    if (m === null) {
      problems.push(`${e.id}：源内找不到声明（${e.decl.source}）`);
      continue;
    }
    // 同 id 可能在源里出现多次（声明 + 包装层）——逐候选验证：找第一个带文档注释且含 @example 的匹配
    // 注：全局化副本循环（非全局正则 exec 恒返首匹配 = 死循环前案）
    const re = new RegExp(e.decl.source, e.decl.flags.includes("g") ? e.decl.flags : `${e.decl.flags}g`);
    let doc: string | undefined;
    let idx = -1;
    for (let mm = re.exec(source); mm !== null; mm = re.exec(source)) {
      const d = docBlockAbove(source, mm.index);
      if (d !== undefined && d.includes("@example")) {
        doc = d;
        idx = mm.index;
        break;
      }
    }
    if (doc === undefined) {
      // 再放宽一轮：只要求有文档块（有 example 的候选优先已试过）
      const mm = e.decl.exec(source);
      const d = mm !== null ? docBlockAbove(source, mm.index) : undefined;
      if (d === undefined) {
        problems.push(`${e.id}：声明前没有文档注释`);
        continue;
      }
      problems.push(`${e.id}：文档注释缺 @example`);
      continue;
    }
    void idx;
    const declLine = source.slice(idx, source.indexOf("\n", idx)).trim();
    const example = exampleOf(doc);
    if (example === undefined) {
      problems.push(`${e.id}：@example 围栏解析失败`);
      continue;
    }
    const sec = sections.get(e.area) ?? [];
    sec.push(`### ${e.id}\n\n${firstSentence(doc)}\n\n\`\`\`ts\n${declLine}\n\`\`\`\n\n\`\`\`ts\n${example}\n\`\`\`\n`);
    sections.set(e.area, sec);
  }
  if (problems.length > 0) {
    throw new Error(`扩展点目录 fail-loud（缺注释/缺 @example/找不到声明）：\n${problems.join("\n")}`);
  }
  const order: CatalogEntry["area"][] = ["贡献点", "交互 UI", "读面与设置", "基础设施"];
  const parts: string[] = [
    "# Orosus 模块扩展点目录（机器生成——勿手改）",
    "",
    "> 本文件由 `scripts/gen-extension-catalog.mts` 从 `packages/contracts/src/module/index.ts` 生成",
    "> （`pnpm gen-extension-catalog`；docs:check 门禁验同步）。帮用户写模块的 AI 请先读这份目录——",
    "> 每个口子给：一句人话、声明形态、可抄示例。源里没有的口子不存在；缺注释或缺示例的口子过不了门禁。",
    "",
  ];
  let count = 0;
  for (const area of order) {
    const items = sections.get(area) ?? [];
    count += items.length;
    parts.push(`## ${area}\n`, ...items.map((x) => x + "\n"));
  }
  return { markdown: parts.join("\n"), entries: count };
}

// ---- 脚本入口（测试 import 时不执行——VITEST 环境变量守卫 + 直接执行判定） ----
const selfPath = fileURLToPath(import.meta.url).split("\\").join("/").split("/").pop() ?? "";
const argvPath = (process.argv[1] ?? "").split("\\").join("/").split("/").pop() ?? "";
const isMain = process.env.VITEST === undefined && selfPath === argvPath;
if (isMain) {
  const root = join(fileURLToPath(new URL("..", import.meta.url)));
  const source = readFileSync(join(root, "packages/contracts/src/module/index.ts"), "utf8");
  try {
    const { markdown, entries } = buildCatalog(source);
    writeFileSync(join(root, "docs/extension-catalog.md"), markdown, "utf8");
    console.log(`docs/extension-catalog.md 已生成（${entries} 个扩展点）`);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
