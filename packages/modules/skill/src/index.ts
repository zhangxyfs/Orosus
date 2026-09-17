import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { Access, defineTool, type Tool } from "@orosus/contracts/tool";

/**
 * skill 模块（T17，计划定稿形态——模块文档随实现批次补，M1 三模块同例）：
 * 扫描 ~/.orosus/skills/* 与 <cwd>/.orosus/skills/*——每子目录一个 SKILL.md
 * （YAML frontmatter：name/description——手写 key: value 行解析，两字段足够）。
 * 贡献：promptSection（可用技能摘要，order 0 区）+ 工具 skill__load（读全文）。
 * 用户级覆盖项目级（§8.7 同理）。声明式内容模块（M3 后）是本模块的演进位。
 */

interface Skill {
  name: string;
  description: string;
  body: string;
  file: string;
}

const parseFrontmatter = (raw: string): { name: string; description: string; body: string } | undefined => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (m === null) return undefined;
  const [, head, body] = m;
  const fields = new Map<string, string>();
  for (const line of (head ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const name = fields.get("name");
  const description = fields.get("description") ?? "";
  if (name === undefined || name === "") return undefined;
  return { name, description, body: body ?? "" };
};

function scanSkills(dirs: Array<{ dir: string; layer: "user" | "project" }>): Skill[] {
  // 项目级先入表，用户级后覆盖（§8.7 同理：用户手放的赢不过——见下，用户级后写覆盖项目级键）
  const byName = new Map<string, Skill>();
  const order: Array<{ dir: string; layer: "user" | "project" }> = [
    ...dirs.filter((d) => d.layer === "project"),
    ...dirs.filter((d) => d.layer === "user"),
  ]; // 用户级后写覆盖项目级（byName 后写者胜）
  for (const { dir } of order) {
    if (!existsSync(dir)) continue;
    for (const sub of readdirSync(dir).sort()) {
      const file = join(dir, sub, "SKILL.md");
      if (!existsSync(file)) continue;
      const parsed = parseFrontmatter(readFileSync(file, "utf8"));
      if (parsed === undefined) continue;
      byName.set(parsed.name, { ...parsed, file });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function loadTool(skills: Skill[]): Tool {
  return defineTool({
    name: "skill__load",
    description: "读取指定技能的完整内容（摘要常驻系统提示，本文按需加载）",
    parameters: z.object({ name: z.string().describe("技能名（见系统提示中的可用技能列表）") }),
    resolveExecution: async (input) => {
      const { name } = input as { name: string };
      return {
        accesses: [Access.fsRead(`~/.orosus/skills/${name}/SKILL.md`)],
        approvalRule: "skill__load",
        execute: async () => {
          const s = skills.find((x) => x.name === name);
          if (s === undefined) return { output: `技能 "${name}" 不存在（可用：${skills.map((x) => x.name).join("、") || "无"}）`, isError: true };
          return { output: s.body, isError: false };
        },
      };
    },
  });
}

export default defineModule({
  name: "skill",
  version: "0.1.0",
  description: "skills 内容系统——扫描 SKILL.md，摘要进系统提示 + skill__load 按需加载全文",
  api: 1,
  uses: ["fs.read"],
  activate(ctx) {
    const cfg = ctx.config as { userDir?: string; projectDir?: string } | undefined;
    const userDir = cfg?.userDir ?? join(homedir(), ".orosus", "skills");
    const projectDir = cfg?.projectDir ?? join(process.cwd(), ".orosus", "skills");
    const skills = scanSkills([{ dir: userDir, layer: "user" }, { dir: projectDir, layer: "project" }]);
    if (skills.length === 0) return; // 无技能零贡献（空转合法）
    const summary = skills.map((s) => `${s.name} — ${s.description}`).join("\n");
    ctx.contribute.promptSection({ order: 0, text: `可用技能（skill__load 按需加载全文）：\n${summary}` });
    ctx.contribute.tool(loadTool(skills));
  },
});
