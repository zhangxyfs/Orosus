import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleContext, PromptSection } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import def from "./index.ts";

type Ctx = Parameters<typeof def.activate>[0];
const md = (p: string) => mkdirSync(p, { recursive: true });

let user: string;
let proj: string;
let savedCwd: string;
const dirs: string[] = [];
beforeEach(() => {
  user = mkdtempSync(join(tmpdir(), "skill-user-")); dirs.push(user);
  proj = mkdtempSync(join(tmpdir(), "skill-proj-")); dirs.push(proj);
  savedCwd = process.cwd();
  process.chdir(proj);
});
afterEach(() => { process.chdir(savedCwd); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeCtx() {
  const services = new Map<string, unknown>();
  const tools: Tool[] = [];
  const sections: PromptSection[] = [];
  const ctx = {
    config: { userDir: join(user, "skills"), projectDir: join(proj, ".orosus", "skills") },
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    services: { get: () => Promise.reject(new Error("no")), getOptional: () => Promise.resolve(undefined) },
    provide: (k: string, impl: unknown) => void services.set(k, impl),
    contribute: {
      tool: (t: Tool) => { tools.push(t); return () => {}; },
      command: () => () => {},
      promptSection: (s: PromptSection) => { sections.push(s); return () => {}; },
    },
    session: { append: () => {} },
    events: { on: () => () => {}, emit: () => Promise.resolve() },
  } as unknown as Ctx;
  return { ctx, services, tools, sections };
}

const SKILL_MD = (name: string, desc: string, body: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;

describe("skill 模块（T17，计划定稿形态）", () => {
  it("① 扫描两级目录 → promptSection 摘要含 name—description 行 + skill__load 读全文", async () => {
    md(join(user, "skills", "git-helper"));
    writeFileSync(join(user, "skills", "git-helper", "SKILL.md"), SKILL_MD("git-helper", "Git 操作指南", "正文内容 ABC"));
    md(join(proj, ".orosus", "skills", "deploy"));
    writeFileSync(join(proj, ".orosus", "skills", "deploy", "SKILL.md"), SKILL_MD("deploy", "部署流程", "部署正文 XYZ"));
    const { ctx, sections, tools } = fakeCtx();
    await def.activate(ctx as ModuleContext<{ userDir?: string; projectDir?: string }>);
    const summary = sections[0]!.text;
    expect(summary).toContain("git-helper");
    expect(summary).toContain("Git 操作指南");
    expect(summary).toContain("deploy");
    const load = tools.find((t) => t.name === "skill__load")!;
    const exec = await load.resolveExecution({ name: "git-helper" });
    const r = await exec.execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
    expect(r.output).toContain("正文内容 ABC");
  });

  it("② 无 skills 目录 → 模块照常激活、零贡献", async () => {
    const { ctx, sections, tools } = fakeCtx();
    await def.activate(ctx as ModuleContext<{ userDir?: string; projectDir?: string }>);
    expect(sections).toHaveLength(0);
    expect(tools).toHaveLength(0);
  });

  it("③ 用户级/项目级同名 → 用户级胜（§8.7 来源优先级同理）", async () => {
    md(join(user, "skills", "dup"));
    writeFileSync(join(user, "skills", "dup", "SKILL.md"), SKILL_MD("dup", "用户级描述", "用户级正文"));
    md(join(proj, ".orosus", "skills", "dup"));
    writeFileSync(join(proj, ".orosus", "skills", "dup", "SKILL.md"), SKILL_MD("dup", "项目级描述", "项目级正文"));
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx as ModuleContext<{ userDir?: string; projectDir?: string }>);
    const load = tools.find((t) => t.name === "skill__load")!;
    const exec = await load.resolveExecution({ name: "dup" });
    const r = await exec.execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
    expect(r.output).toContain("用户级正文");
    expect(r.output).not.toContain("项目级正文");
  });

  it("④ skill__load 不存在的技能 → 带内 isError", async () => {
    md(join(user, "skills", "real"));
    writeFileSync(join(user, "skills", "real", "SKILL.md"), SKILL_MD("real", "d", "b"));
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx as ModuleContext<{ userDir?: string; projectDir?: string }>);
    const load = tools.find((t) => t.name === "skill__load")!;
    const exec = await load.resolveExecution({ name: "ghost" });
    const r = await exec.execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
    expect(r.isError).toBe(true);
  });
});
