import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModuleContext, PromptSection } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import { z } from "zod";
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

function fakeCtx(cfg: Record<string, unknown> = {}) {
  const services = new Map<string, unknown>();
  const tools: Tool[] = [];
  const sections: PromptSection[] = [];
  const warns: { code: string; msg?: string | undefined }[] = []; // MI-09：坏轨/坏条目告警捕获
  const ctx = {
    config: cfg,
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn(code: string, msg?: string) { warns.push({ code, msg }); }, error() {} },
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
  return { ctx, services, tools, sections, warns };
}

const put = (dir: string, name: string, desc: string, body: string, extra = "") => {
  md(join(dir, name));
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}${extra}\n---\n\n${body}\n`);
};

const runLoad = async (tools: Tool[], name: string) => {
  const load = tools.find((t) => t.name === "skill__load")!;
  const exec = await load.resolveExecution({ name });
  return exec.execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
};

/** 四轨全注（绕开真实 home/git 探测——探测链另测；bundled 注空目录——第五轨真身另测）。 */
const fourTrackCfg = () => ({
  userAgentsDir: join(user, ".agents", "skills"),
  userOrosusDir: join(user, ".orosus", "skills"),
  projectAgentsDirs: [join(proj, ".agents", "skills")],
  projectOrosusDir: join(proj, ".orosus", "skills"),
  bundledDir: join(user, "bundled-empty"),
});

describe("skill 模块（m4-7 T1/T2——四轨目录 + frontmatter 扩集）", () => {
  it("① 四轨扫描 → promptSection 摘要 + skill__load 读全文（工具无条件注册）", async () => {
    put(join(user, ".agents", "skills"), "git-helper", "Git 操作指南", "正文内容 ABC");
    put(join(proj, ".orosus", "skills"), "deploy", "部署流程", "部署正文 XYZ");
    const { ctx, sections, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const summary = sections[0]!.text;
    expect(summary).toContain("git-helper");
    expect(summary).toContain("Git 操作指南");
    expect(summary).toContain("deploy");
    const r = await runLoad(tools, "git-helper");
    expect(r.output).toContain("正文内容 ABC");
  });

  it("② 无 skills 目录 → 零提示段贡献；load 工具仍注册（T4 重扫前提——会话中途放技能可指名加载）", async () => {
    const { ctx, sections, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections).toHaveLength(0);
    expect(tools.map((t) => t.name)).toContain("skill__load");
  });

  it("③ 同名强弱序四层（m4-7 翻转拍板：项目压用户 + 品牌压通用）——项目 .orosus > 项目 .agents > ~/.orosus > ~/.agents", async () => {
    put(join(user, ".agents", "skills"), "dup", "用户通用", "用户 agents 正文");
    put(join(user, ".orosus", "skills"), "dup", "用户品牌", "用户 orosus 正文");
    put(join(proj, ".agents", "skills"), "dup", "项目通用", "项目 agents 正文");
    put(join(proj, ".orosus", "skills"), "dup", "项目品牌", "项目 orosus 正文");
    const { ctx, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const r = await runLoad(tools, "dup");
    expect(r.output).toContain("项目 orosus 正文");
    // 逐层降强：撤掉项目品牌 → 项目 agents 胜；再撤 → 用户品牌胜
  });

  it("③-b 降层链：项目品牌缺席 → 项目通用胜；项目全缺席 → 用户品牌压用户通用", async () => {
    put(join(user, ".agents", "skills"), "dup", "用户通用", "用户 agents 正文");
    put(join(user, ".orosus", "skills"), "dup", "用户品牌", "用户 orosus 正文");
    put(join(proj, ".agents", "skills"), "dup", "项目通用", "项目 agents 正文");
    const { ctx, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect((await runLoad(tools, "dup")).output).toContain("项目 agents 正文");
  });

  it("④ skill__load 不存在的技能 → 带内 isError", async () => {
    put(join(user, ".orosus", "skills"), "real", "d", "b");
    const { ctx, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const r = await runLoad(tools, "ghost");
    expect(r.isError).toBe(true);
  });

  it("⑤ .agents 逐层向上到 git 根（缺省目录解析）：子目录 cwd 捡到根技能 + 就近覆盖", async () => {
    md(join(proj, ".git")); // 空目录即可——gitRootOf 只探测 .git 在场性
    const appDir = join(proj, "packages", "app");
    md(appDir);
    process.chdir(appDir);
    put(join(proj, ".agents", "skills"), "root-skill", "根技能", "根正文");
    put(join(appDir, ".agents", "skills"), "root-skill", "就近同名", "就近正文");
    const { ctx, sections } = fakeCtx({ userOrosusDir: join(user, "none1"), userAgentsDir: join(user, "none2"), bundledDir: join(user, "none3") });
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const summary = sections[0]!.text;
    expect(summary).toContain("root-skill"); // 根技能被子目录 cwd 捡到（monorepo 场景）
    expect(summary).not.toContain("根技能"); // 同名就近覆盖（cwd 层压根层）
    expect(summary).toContain("就近同名");
  });

  it("⑥ 品牌目录收窄：.orosus/skills 只认项目根本身——子目录里的 .orosus 不扫（同名多版本混乱，故意收窄）", async () => {
    md(join(proj, ".git"));
    const appDir = join(proj, "packages", "app");
    md(appDir);
    process.chdir(appDir);
    put(join(appDir, ".orosus", "skills"), "sub-brand", "子目录品牌", "子目录正文");
    const { ctx, sections } = fakeCtx({ userOrosusDir: join(user, "none1"), userAgentsDir: join(user, "none2"), bundledDir: join(user, "none3") });
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections).toHaveLength(0); // app/.orosus 不在轨道上；根 .orosus 也没内容
  });

  it("⑦ when_to_use 解析进 catalog 行（菜单详释第 3 行数据源）", async () => {
    put(join(user, ".orosus", "skills"), "annotated", "带适用说明", "b", "\nwhen_to_use: 需要 PDF 交付时");
    const { ctx, services } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const catalog = services.get("skill.catalog") as () => Array<{ name: string; whenToUse?: string; layer: string; source: string }>;
    const row = catalog().find((r) => r.name === "annotated")!;
    expect(row.whenToUse).toBe("需要 PDF 交付时");
    expect(row.layer).toBe("user");
    expect(row.source).toBe("orosus");
  });

  it("⑧ disable-model-invocation（值恰为 true）：不进 promptSection，但 load 指名仍给正文（用户手动路径不受限）", async () => {
    put(join(user, ".orosus", "skills"), "manual-only", "纯手动技能", "手动正文", "\ndisable-model-invocation: true");
    put(join(user, ".orosus", "skills"), "explicit-false", "显式 false", "常规正文", "\ndisable-model-invocation: false");
    const { ctx, sections, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).not.toContain("manual-only");
    expect(sections[0]!.text).toContain("explicit-false"); // false 不算禁——值恰为 true 才算
    const r = await runLoad(tools, "manual-only");
    expect(r.isError).toBe(false);
    expect(r.output).toContain("手动正文");
  });

  it("⑨ 未知键丢弃维持（宽松派）——frontmatter 带未知键照常解析", async () => {
    put(join(user, ".orosus", "skills"), "loose", "宽松", "正文", "\nallowed-tools: Read, Grep\nhooks: whatever");
    const { ctx, sections } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).toContain("loose");
  });
});

describe("skill 模块（m4-7 T3——清单预算与降级）", () => {
  it("① 单条 description 超 250 字符进摘要即截断（cc MAX_LISTING_DESC_CHARS 同值）", async () => {
    const long = "长".repeat(300);
    put(join(user, ".orosus", "skills"), "long-desc", long, "b");
    const { ctx, sections } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const row = sections[0]!.text.split("\n").find((l) => l.startsWith("long-desc"))!;
    expect(row).toContain("长".repeat(250) + "…");
    expect(row).not.toContain("长".repeat(251));
  });

  it("② 段总预算 4000：正常不触；超限整段降级为仅技能名列表（不带描述不带路径）", async () => {
    // 17 条 × 249 字符 ≈ 4250 > 4000 → 降级
    for (let i = 0; i < 17; i++) put(join(user, ".orosus", "skills"), `bulk-${i}`, "描".repeat(249), "b");
    const { ctx, sections } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const text = sections[0]!.text;
    expect(text).toContain("清单超预算，仅列名");
    expect(text).toContain("bulk-0");
    expect(text).toContain("bulk-16"); // 仅名列表（名间空格连接，字典序排列）
    expect(text).not.toContain("—"); // 不再有 name — desc 行形态
  });

  it("③ 降级边界：15 条 × 249 ≈ 3920 不降级（保持 name — desc 行）", async () => {
    for (let i = 0; i < 15; i++) put(join(user, ".orosus", "skills"), `bulk-${i}`, "描".repeat(249), "b");
    const { ctx, sections } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).not.toContain("清单超预算");
    expect(sections[0]!.text.split("\n").filter((l) => l.includes("—"))).toHaveLength(15);
  });
});

describe("skill 模块（m4-7 T4/T5——skill__load 三修 + 去重重置口）", () => {
  it("① MI-16 accesses 常量声明：声明期零 fs 扫描（契约①「声明期无副作用」）——五轨搜索根 fsRead（CT-04 搜索类工具纪律：fsRead 只收字面路径，搜索根整段声明），execute 重扫命中的真实文件恒在声明集内", async () => {
    put(join(proj, ".orosus", "skills"), "proj-skill", "d", "b");
    writeFileSync(join(user, "not-a-dir"), "x"); // 坏轨（ENOTDIR）：旧实现声明期 hit() 即扫——声明阶段就多一次扫描副作用
    const cfg = { ...fourTrackCfg(), userAgentsDir: join(user, "not-a-dir") };
    const { ctx, tools, warns } = fakeCtx(cfg);
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const scanWarns = (): number => warns.filter((w) => w.code === "skill.track-scan-failed").length;
    expect(scanWarns()).toBe(1); // activate 期固有的一次扫描（清单用）
    const load = tools.find((t) => t.name === "skill__load")!;
    const exec = await load.resolveExecution({ name: "proj-skill" });
    // 五轨根常量声明（tracks 序：bundled 垫底首位）——不随技能名/命中结果变化
    expect(exec.accesses).toEqual([
      { kind: "fs.read", path: cfg.bundledDir },
      { kind: "fs.read", path: join(user, "not-a-dir") },
      { kind: "fs.read", path: cfg.userOrosusDir },
      { kind: "fs.read", path: cfg.projectAgentsDirs[0] },
      { kind: "fs.read", path: cfg.projectOrosusDir },
    ]);
    expect(scanWarns()).toBe(1); // 核心钉：声明期零扫描（旧实现 hit() 再扫一次坏轨 → 2，且违契约①）
    const r = await exec.execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
    expect(r.output).toContain("b"); // execute 重扫照常命中真实文件（在声明集内——TOCTOU 缝隙闭合）
    expect(scanWarns()).toBe(2); // 扫描副作用归位执行阶段
  });

  it("② 执行时重扫（ZCode）：activate 后新放的技能指名即加载，无需 reload", async () => {
    put(join(user, ".orosus", "skills"), "old-one", "d", "旧正文");
    const { ctx, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    put(join(user, ".orosus", "skills"), "late-comer", "新技能", "新放技能的正文");
    const r = await runLoad(tools, "late-comer");
    expect(r.isError).toBe(false);
    expect(r.output).toContain("新放技能的正文");
  });

  it("③ 运行时去重（qwen）：同一技能重调 → 不重发正文，回确认句；不同技能互不影响", async () => {
    put(join(user, ".orosus", "skills"), "dedup", "d", "只该出现一次的正文");
    put(join(user, ".orosus", "skills"), "other", "d", "另一个技能");
    const { ctx, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const first = await runLoad(tools, "dedup");
    expect(first.output).toContain("只该出现一次的正文");
    const second = await runLoad(tools, "dedup");
    expect(second.output).toBe('技能 "dedup" 已加载过，正文在上方对话中，请直接按其行事。');
    expect(second.isError).toBe(false);
    expect((await runLoad(tools, "other")).output).toContain("另一个技能");
  });

  it("④ skill.resetLoaded 重置口：clear 后重调重新给正文（compact 压掉正文后的钩子——宿主惰性调用）", async () => {
    put(join(user, ".orosus", "skills"), "dedup", "d", "正文再次出现");
    const { ctx, tools, services } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    await runLoad(tools, "dedup");
    (services.get("skill.resetLoaded") as () => void)();
    const again = await runLoad(tools, "dedup");
    expect(again.output).toContain("正文再次出现");
  });

  it("⑤ 不存在清单与错误面：重扫后可用名单随实况（新建技能后 ghost 的可用列表含新名）", async () => {
    put(join(user, ".orosus", "skills"), "known", "d", "b");
    const { ctx, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    put(join(user, ".orosus", "skills"), "newly", "新", "b");
    const r = await runLoad(tools, "ghost");
    expect(r.isError).toBe(true);
    expect(r.output).toContain("newly"); // 可用列表是执行时现扫的
  });
});

describe("skill 模块（m4-7 T6——停用清单）", () => {
  it("① config disabled：不进 promptSection、load 拒绝带出路、catalog 行带 disabled 标志（全收不丢条目）", async () => {
    put(join(user, ".orosus", "skills"), "off-skill", "被停的", "正文");
    put(join(user, ".orosus", "skills"), "on-skill", "在用的", "正文");
    const { ctx, sections, tools, services } = fakeCtx({ ...fourTrackCfg(), disabled: ["off-skill"] });
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).toContain("on-skill");
    expect(sections[0]!.text).not.toContain("off-skill");
    const r = await runLoad(tools, "off-skill");
    expect(r.isError).toBe(true);
    expect(r.output).toContain("已停用");
    expect(r.output).toContain("/settings → 技能");
    const catalog = services.get("skill.catalog") as () => Array<{ name: string; disabled: boolean; modelInvocable: boolean }>;
    const off = catalog().find((x) => x.name === "off-skill")!;
    expect(off.disabled).toBe(true); // 管理面全收口径（扫描层不丢条目，消费面各自裁剪）
    expect(catalog().find((x) => x.name === "on-skill")!.disabled).toBe(false);
  });

  it("② catalog 的 modelInvocable 标志（disable-model-invocation 者照收但标记不可自动调——菜单照显）", async () => {
    put(join(user, ".orosus", "skills"), "manual-only", "纯手动", "b", "\ndisable-model-invocation: true");
    const { ctx, services } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const catalog = services.get("skill.catalog") as () => Array<{ name: string; modelInvocable: boolean }>;
    expect(catalog().find((x) => x.name === "manual-only")!.modelInvocable).toBe(false);
  });

  it("③ 停用与 disable-model-invocation 双标志独立判定（两者都标 = 双摘，但 catalog 仍在册）", async () => {
    put(join(user, ".orosus", "skills"), "both", "双标", "b", "\ndisable-model-invocation: true");
    const { ctx, sections, services } = fakeCtx({ ...fourTrackCfg(), disabled: ["both"] });
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections).toHaveLength(0);
    const catalog = services.get("skill.catalog") as () => Array<{ name: string; disabled: boolean; modelInvocable: boolean }>;
    const row = catalog().find((x) => x.name === "both")!;
    expect(row.disabled).toBe(true);
    expect(row.modelInvocable).toBe(false);
  });
});

describe("skill 模块（m4-7 走查修——config schema：内核规则未声明 schema 拒收额外键，disabled 一写盘模块即 failed、启动冒引导弹窗）", () => {
	it("① schema 放行 disabled 与注轨键、strip 未知键（z.object 缺省语义）——真实启动校验路径的形态钉", async () => {
		const { configSchema } = await import("./index.ts") as unknown as { configSchema: z.ZodType };
		const parsed = configSchema.parse({ disabled: ["a", "b"], userAgentsDir: "D:/x", projectAgentsDirs: ["D:/y"], ghost: 1 });
		expect(parsed).toEqual({ disabled: ["a", "b"], userAgentsDir: "D:/x", projectAgentsDirs: ["D:/y"] }); // ghost 被 strip
		expect(configSchema.parse({})).toEqual({}); // 空节合法
		expect(() => configSchema.parse({ disabled: "a" })).toThrow(); // 非数组拒收
	});
});

describe("skill 模块（m4-7 T11/T12——第五轨内置目录 + 出厂技能）", () => {
  /** 模块自带 bundled/ 真身（包根下，src 的上一级）——其余轨道注空保隔离。 */
  const bundledOnlyCfg = () => ({
    userAgentsDir: join(user, "none-agents"),
    userOrosusDir: join(user, "none-orosus"),
    projectAgentsDirs: [join(proj, "none-pagents")],
    projectOrosusDir: join(proj, "none-porosus"),
    bundledDir: join(dirname(fileURLToPath(import.meta.url)), "..", "bundled"),
  });

  it("① 出厂技能可发现可加载：skill-creator 进清单、正文可读、catalog 范围 = 内置（bundled）", async () => {
    const { ctx, sections, tools, services } = fakeCtx(bundledOnlyCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).toContain("skill-creator");
    const r = await runLoad(tools, "skill-creator");
    expect(r.isError).toBe(false);
    expect(r.output).toContain("Progressive disclosure");
    const catalog = services.get("skill.catalog") as () => Array<{ name: string; layer: string; source: string }>;
    const row = catalog().find((x) => x.name === "skill-creator")!;
    expect(row.layer).toBe("bundled");
    expect(row.source).toBe("bundled");
  });

  it("② 垫底可覆盖：~/.agents 同名 skill-creator 压过内置版（九仓惯例——出厂技能用户同名可覆盖）", async () => {
    put(join(user, "none-agents"), "skill-creator", "用户自定义版", "用户自定义正文 XYZ");
    const { ctx, tools } = fakeCtx(bundledOnlyCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const r = await runLoad(tools, "skill-creator");
    expect(r.output).toContain("用户自定义正文 XYZ");
  });

  it("③ 停用对内置技能同样适用：disabled 含 skill-creator → 清单摘除、load 拒绝、catalog 在册带标志", async () => {
    const { ctx, sections, tools, services } = fakeCtx({ ...bundledOnlyCfg(), disabled: ["skill-creator"] });
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).not.toContain("skill-creator"); // 摘除该件（其余出厂件照常在册——非单件时代不再断言整段为空）
    const r = await runLoad(tools, "skill-creator");
    expect(r.isError).toBe(true);
    expect(r.output).toContain("已停用");
    const catalog = services.get("skill.catalog") as () => Array<{ name: string; disabled: boolean }>;
    expect(catalog().find((x) => x.name === "skill-creator")!.disabled).toBe(true);
  });

  it("④ 出厂十件全量走查（T13-T21 自举验收——explore 按 T21 前置跳过：tool-subagent 内置 research 工种已覆盖其只读探索语义）：每件进清单、正文可加载非空、简单说明齐", async () => {
    const EXPECTED = ["batch", "code-review", "commit", "doc-review", "doc-writer", "goal-draft", "research", "simplify", "skill-creator", "update-config"];
    const { ctx, sections, tools, services } = fakeCtx(bundledOnlyCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const summary = sections[0]!.text;
    const catalog = services.get("skill.catalog") as () => Array<{ name: string; whenToUse?: string }>;
    const names = catalog().map((r) => r.name);
    for (const n of EXPECTED) {
      expect(names).toContain(n);
      expect(summary).toContain(n);
      const r = await runLoad(tools, n);
      expect(r.isError).toBe(false);
      expect((r.output as string).trim().length).toBeGreaterThan(200); // 正文非占位
    }
    expect(catalog().every((r) => r.whenToUse !== undefined)).toBe(true); // 每件都写了简单说明（菜单详释第 3 行）
    expect(names).toHaveLength(EXPECTED.length); // 无意外多余件
  });
});

describe("MI-09 扫描容错（单轨/单条目级 try/catch——一处坏文件系统状态不再拖垮整个 skill 模块）", () => {
  it("① 轨道目录本身是文件（ENOTDIR）→ 该轨跳过、其余轨道照常、模块不降级（旧实现 readdirSync 直抛 → activate 失败五轨全丢：内置技能/清单段/load 工具一起消失）", async () => {
    writeFileSync(join(user, "not-a-dir"), "x"); // 存在但不可 readdir 的「轨道」
    put(join(user, ".orosus", "skills"), "healthy", "好技能", "好正文");
    const { ctx, sections, tools, warns } = fakeCtx({ ...fourTrackCfg(), userAgentsDir: join(user, "not-a-dir") });
    await def.activate(ctx as ModuleContext<Record<string, unknown>>); // 旧实现这里直接抛
    expect(sections[0]!.text).toContain("healthy"); // 其余轨道照常
    expect(tools.map((t) => t.name)).toContain("skill__load"); // 工具照常注册
    expect(warns.some((w) => w.code === "skill.track-scan-failed")).toBe(true); // 坏轨经 warn 可观测（不静默吞）
  });

  it("② 单条目 SKILL.md 不可读（EISDIR——SKILL.md 是目录）→ 跳过该条、同轨其余技能照常", async () => {
    md(join(user, ".orosus", "skills", "broken"));
    mkdirSync(join(user, ".orosus", "skills", "broken", "SKILL.md")); // 目录占名——readFileSync 抛 EISDIR
    put(join(user, ".orosus", "skills"), "sibling", "同伴技能", "同伴正文");
    const { ctx, sections, warns } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).toContain("sibling"); // 同轨同伴不受株连
    expect(sections[0]!.text).not.toContain("broken");
    expect(warns.some((w) => w.code === "skill.entry-scan-failed")).toBe(true);
  });

  it("③ 运行期面同样容错：skill.catalog 现读与 skill__load 执行时重扫遇坏轨不炸（宿主菜单/工具调用不受损）", async () => {
    writeFileSync(join(user, "not-a-dir"), "x");
    put(join(user, ".orosus", "skills"), "healthy", "好技能", "好正文");
    const { ctx, services, tools } = fakeCtx({ ...fourTrackCfg(), userAgentsDir: join(user, "not-a-dir") });
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const catalog = services.get("skill.catalog") as () => Array<{ name: string }>;
    expect(catalog().map((r) => r.name)).toEqual(["healthy"]); // 现读服务不炸
    const r = await runLoad(tools, "healthy"); // load 工具的重扫路径同样不炸
    expect(r.isError).toBe(false);
    expect(r.output).toContain("好正文");
  });
});

describe("MI-10 CRLF frontmatter（Windows/互操作生态——别家工具写进来的 SKILL.md 不再静默消失）", () => {
  it("① CRLF 全文照常解析：清单见名与描述、正文可加载、字段行尾 \\r 被 trim 吃掉（旧实现 ^---\\n 不匹配 → 整文件静默跳过）", async () => {
    md(join(user, ".orosus", "skills", "crlf-skill"));
    writeFileSync(
      join(user, ".orosus", "skills", "crlf-skill", "SKILL.md"),
      "---\r\nname: crlf-skill\r\ndescription: Windows 换行技能\r\nwhen_to_use: 需要 CRLF 时\r\n---\r\n\r\nCRLF 正文内容",
    );
    const { ctx, sections, tools, services } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).toContain("crlf-skill"); // 核心钉：不再静默消失
    expect(sections[0]!.text).toContain("Windows 换行技能");
    const r = await runLoad(tools, "crlf-skill");
    expect(r.isError).toBe(false);
    expect(r.output).toContain("CRLF 正文内容");
    const catalog = services.get("skill.catalog") as () => Array<{ name: string; whenToUse?: string }>;
    expect(catalog().find((x) => x.name === "crlf-skill")!.whenToUse).toBe("需要 CRLF 时"); // 行尾 \r 已 trim
  });

  it("② 混合换行（CRLF 头 + LF 正文）与 bare `---` 收尾（无尾换行）均不炸——宽松回归钉", async () => {
    md(join(user, ".orosus", "skills", "mixed-skill"));
    writeFileSync(join(user, ".orosus", "skills", "mixed-skill", "SKILL.md"), "---\r\nname: mixed-skill\r\ndescription: 混合\r\n---\n正文");
    const { ctx, sections } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    expect(sections[0]!.text).toContain("mixed-skill");
    md(join(user, ".orosus", "skills", "bare-end"));
    writeFileSync(join(user, ".orosus", "skills", "bare-end", "SKILL.md"), "---\nname: bare-end\ndescription: 裸尾\n---");
    const s2 = fakeCtx(fourTrackCfg());
    await def.activate(s2.ctx as ModuleContext<Record<string, unknown>>);
    expect(s2.sections[0]!.text).toContain("bare-end"); // 收尾 `---` 后无换行：\r?\n? 全可选——照常解析
  });
});

describe("skill 工具行显示名 label（2026-09-29 用户走查报「Used Load」不可辨——label 契约补齐）", () => {
  it("skill__load 带 label「Skill_load」——工具行显示可辨，模型/审批面 name 不变", async () => {
    const { ctx, tools } = fakeCtx(fourTrackCfg());
    await def.activate(ctx as ModuleContext<Record<string, unknown>>);
    const load = tools.find((t) => t.name === "skill__load")!;
    expect(load).toBeDefined();
    expect((load as unknown as { label?: string }).label).toBe("Skill_load");
  });
});
