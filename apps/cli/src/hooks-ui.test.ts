import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { hooksFace, rowLabel, setHookDisabled, trustProjectHooks } from "./hooks-ui.ts";
import { injectionFoldLabel } from "./render.ts";
import { renderEvent } from "./render.ts";
import { SETTINGS_ITEMS } from "./settings-ui.ts";

let dir: string;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

const USER_TOML = (file: string): string => `
[hooks]
[[hooks.PreToolUse]]
matcher = "^bash$"
[[hooks.PreToolUse.hooks]]
command = "check.sh"

[[hooks.PreToolUse.hooks]]
command = "guard.py"
timeout = 30
`;

describe("/settings 钩子面板（m5-hooks T10）", () => {
	it("① 根列表含钩子项（技能后、MCP 前——用户拍板不设 /hooks 命令）", async () => {
		const i = SETTINGS_ITEMS.findIndex((x) => x.startsWith("技能"));
		const j = SETTINGS_ITEMS.findIndex((x) => x.startsWith("钩子"));
		const k = SETTINGS_ITEMS.findIndex((x) => x.startsWith("MCP"));
		expect(i).toBeGreaterThanOrEqual(0);
		expect(j).toBe(i + 1);
		expect(k).toBe(j + 1);
	});

	it("② hooksFace 两层分行（路径注入密封）：行含事件/来源/命令/matcher/超时；项目层信任态现算（未登记 = 待审；无项目层 = 不适用）", () => {
		dir = mkdtempSync(join(tmpdir(), "orosus-hooksui-"));
		const userFile = join(dir, "user-hooks.toml");
		const projDir = join(dir, "proj");
		const projectFile = join(projDir, ".orosus", "modules.d", "hooks.toml");
		const trustFile = join(dir, "trust.json");
		mkdirSync(join(projDir, ".orosus", "modules.d"), { recursive: true });
		writeFileSync(userFile, USER_TOML(userFile), "utf8");
		const face0 = hooksFace(projDir, { userFile, projectFile, trustFile });
		expect(face0.rows).toHaveLength(2); // 无项目层：仅用户层两行
		expect(face0.projectApplicable).toBe(false);
		writeFileSync(projectFile, '[hooks]\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "keep.sh"\n', "utf8");
		const face = hooksFace(projDir, { userFile, projectFile, trustFile });
		expect(face.rows).toHaveLength(3);
		const stop = face.rows.find((r) => r.event === "Stop")!;
		expect(stop).toMatchObject({ origin: "project", command: "keep.sh" });
		expect(face.projectApplicable).toBe(true);
		expect(face.projectTrusted).toBe(false); // 未登记 = 待审
		trustProjectHooks(projDir, trustFile);
		expect(hooksFace(projDir, { userFile, projectFile, trustFile }).projectTrusted).toBe(true); // 登记后放行
		const userRow = face.rows.find((r) => r.command === "guard.py")!;
		expect(userRow).toMatchObject({ origin: "user", event: "PreToolUse", timeout: 30 });
		expect(userRow.matcher).toBe("^bash$"); // matcher 挂表级——行随表携带
	});

	it("②b 走查修——name/product 显示键：hooksFace 行携带；rowLabel 说明优先（命令撤行）、无 name 回退现状", () => {
		dir = mkdtempSync(join(tmpdir(), "orosus-hooksui-np-"));
		const userFile = join(dir, "user-hooks.toml");
		const projDir = join(dir, "proj");
		writeFileSync(userFile, `[hooks]\n[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ncommand = "ok.exe hook prompt claude"\nname = "提示词捕获"\nproduct = "OpenKnowledge"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "keep.sh"\n`, "utf8");
		const face = hooksFace(projDir, { userFile, projectFile: join(projDir, ".orosus", "modules.d", "hooks.toml"), trustFile: join(dir, "trust.json") });
		const named = face.rows.find((r) => r.product === "OpenKnowledge")!;
		expect(named).toMatchObject({ name: "提示词捕获", product: "OpenKnowledge", event: "PreToolUse" });
		expect(rowLabel(80, named)).toBe("提示词捕获 · OpenKnowledge · PreToolUse · 用户");
		expect(rowLabel(80, named)).not.toContain("ok.exe"); // 命令撤出列表行——详情窗可查
		const bare = face.rows.find((r) => r.name === undefined)!;
		expect(rowLabel(80, bare)).toContain("keep.sh"); // 无 name：现状回退（事件+来源+命令截断）
	});

	it("③ setHookDisabled 行级写：定位第 N 表第 M 钩子置/删 disabled——保 matcher/timeout/注释与结构", () => {
		dir = mkdtempSync(join(tmpdir(), "orosus-hooksui-w-"));
		const file = join(dir, "hooks.toml");
		writeFileSync(file, `# 顶部注释\n[hooks]\nenabled = true\n\n[[hooks.PreToolUse]]\nmatcher = "^bash$"\n\n[[hooks.PreToolUse.hooks]]\ncommand = "check.sh"\n\n[[hooks.PreToolUse.hooks]]\n# 第二个钩子的专属注释\ncommand = "guard.py"\ntimeout = 30\n`, "utf8");
		setHookDisabled(file, "PreToolUse", 0, 1, true); // 第 1 张表的第 2 个钩子
		const after = readFileSync(file, "utf8");
		expect(after).toContain("# 顶部注释");
		expect(after).toContain("matcher");
		expect(after).toContain("# 第二个钩子的专属注释");
		const doc = parse(after) as Record<string, unknown>;
		const hooks = ((doc["hooks"] as Record<string, unknown>)["PreToolUse"] as { hooks: { command: string; disabled?: boolean; timeout?: number }[] }[])[0]!.hooks;
		expect(hooks[1]).toMatchObject({ command: "guard.py", disabled: true, timeout: 30 });
		expect(hooks[0]!.disabled).toBeUndefined(); // 第一个钩子未动
		setHookDisabled(file, "PreToolUse", 0, 1, false); // 复启——disabled 键删除
		const doc2 = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const hooks2 = ((doc2["hooks"] as Record<string, unknown>)["PreToolUse"] as { hooks: { disabled?: boolean }[] }[])[0]!.hooks;
		expect(hooks2[1]!.disabled).toBeUndefined();
	});

	it("④ trustProjectHooks 写盘：登记 digest（键=盘符归一桶名）+ 目录惰性创建 + 坏文件隔离后重写", () => {
		dir = mkdtempSync(join(tmpdir(), "orosus-hooksui-t-"));
		const projRoot = join(dir, "proj");
		mkdirSync(join(projRoot, ".orosus", "modules.d"), { recursive: true });
		writeFileSync(join(projRoot, ".orosus", "modules.d", "hooks.toml"), `[hooks]\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "keep.sh"\n`, "utf8");
		const trustFile = join(dir, "trust", "hooks-trust.json"); // 目录不存在——首写 mkdir recursive
		const { digest } = trustProjectHooks(projRoot, trustFile);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		const table = JSON.parse(readFileSync(trustFile, "utf8")) as Record<string, { digest: string }>;
		const keys = Object.keys(table);
		expect(keys).toHaveLength(1);
		expect(table[keys[0]!]!.digest).toBe(digest);
		// 坏文件容错：写坏 JSON 再信任——原文件隔离留档、新表可用
		writeFileSync(trustFile, "{broken", "utf8");
		const again = trustProjectHooks(projRoot, trustFile);
		expect(again.digest).toBe(digest);
		const table2 = JSON.parse(readFileSync(trustFile, "utf8")) as Record<string, unknown>;
		expect(Object.keys(table2)).toHaveLength(1);
		expect(readdirSync(join(dir, "trust")).some((f) => f.includes(".corrupt-"))).toBe(true);
	});

	it("⑤ 空态文案三场景指引（通知/格式化/守卫）+ 出厂模板与文档指路", async () => {
		// EMPTY_TEXT 未导出——经 help 文案与模板双件钉：help 含三键位与场景（help.ts 集成测），模板见 config-migrate.test
		const { HOOKS_TEMPLATE } = await import("./config-migrate.ts");
		expect(HOOKS_TEMPLATE).toContain("场景一");
		expect(HOOKS_TEMPLATE).toContain("场景二");
		expect(HOOKS_TEMPLATE).toContain("场景三");
	});
});

describe("注入折叠行与修订注记（m5-hooks T10 / D19）", () => {
	it("⑥ injectionFoldLabel：事件名取自包裹头；hooks 源认 Stop 续跑；字符数 = 正文长", () => {
		const text = "[非用户输入] 钩子注入（PostToolUse）\n────────\n格式化完成";
		expect(injectionFoldLabel(text, "host/hook")).toBe(`上下文注入 · PostToolUse · ${text.length} 字符`);
		expect(injectionFoldLabel("[非用户输入] 钩子要求继续：再检查一遍", "hooks")).toBe(`上下文注入 · Stop 续跑 · ${"[非用户输入] 钩子要求继续：再检查一遍".length} 字符`);
	});

	it("⑥b 走查修——injectionFoldLabel name 形态：包裹头「事件 · 名」→「<名> 注入 · N 字符」（老格式无名字段照旧解析）", () => {
		const t = "[非用户输入] 钩子注入（PostToolUse · 提示词捕获）\n────────\n归档完成";
		expect(injectionFoldLabel(t, "host/hook")).toBe(`提示词捕获 注入 · ${t.length} 字符`);
	});

	it("⑦ renderEvent 折叠行：host/hook 与 hooks 消息出灰字行、host/date 与普通 steer 不出", () => {
		const mk = (sourceModule: string | undefined, text = "[非用户输入] 钩子注入（UserPromptSubmit）\n────────\n项目知识"): string => renderEvent({ type: "agent/steering-message", messages: [{ text, sourceModule }] } as never, { reasoningOpen: false } as never);
		expect(mk("host/hook")).toContain("上下文注入 · UserPromptSubmit");
		expect(mk("hooks", "[非用户输入] 钩子要求继续：再检查一遍")).toContain("Stop 续跑"); // hooks 源 = 续跑消息（无包裹头）
		expect(mk("host/date")).toBe("");
		expect(mk(undefined)).toBe("");
	});

	it("⑧ renderEvent 修订注记：hooks/input-rewrite 一行灰字（对账口径文案）", () => {
		const out = renderEvent({ type: "hooks/input-rewrite", callId: "c1", from: {}, to: {} } as never, { reasoningOpen: false } as never);
		expect(out).toContain("钩子改参");
		expect(out).toContain("审批与执行见改后参数");
	});
});
