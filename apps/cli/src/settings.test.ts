import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "@orosus/core";
import { BUILTIN_MODULES } from "./builtins.ts";
import { computeModulePreset, planModulePreset, presetBaseline } from "./modpreset.ts";

/** m5 T9：harness 设置服务出口——与 /model //effort 命令同源核心动作（单一写者不双写）。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const isolated = async (userToml = "") => {
  dir = mkdtempSync(join(tmpdir(), "orosus-settings-"));
  const userFile = join(dir, "config.toml");
  if (userToml !== "") writeFileSync(userFile, userToml, "utf8");
  const h = await createHarness({
    cwd: dir,
    builtinModules: BUILTIN_MODULES,
    secretsFile: join(dir, "secrets.env"),
    diagDir: join(dir, "logs"),
    sessionsDir: join(dir, "sessions"),
    discovery: { userDir: join(dir, "mods"), projectDir: join(dir, "pmods"), trustFile: join(dir, "trust.json") },
    config: { userFile, projectFile: join(dir, "proj.toml"), env: {} },
  });
  return { h, userFile };
};

describe("设置服务出口（m5 T9——/model //effort 同源核心动作）", () => {
	it("① setModel：覆盖槽生效 + 写盘顶层 provider 行唯一（不双写）", async () => {
		const { h, userFile } = await isolated('provider = "old/p1"\n');
		expect(h.status().model).toBe("old/p1");
		await h.setModel("prov-a/model-x");
		expect(h.status().model).toBe("prov-a/model-x");
		expect(h.status().overridden).toBe(true);
		const toml = readFileSync(userFile, "utf8");
		const providerLines = toml.split("\n").filter((l) => /^\s*provider\s*=/.test(l));
		expect(providerLines).toHaveLength(1);
		expect(providerLines[0]).toContain("prov-a/model-x");
		await h.close();
	});

	it("② setEffort：写盘 + status 生效；auto 清行回默认；非法档名抛错", async () => {
		const { h, userFile } = await isolated();
		h.setEffort("high");
		expect(h.status().effort).toBe("high");
		expect(readFileSync(userFile, "utf8")).toContain('effort = "high"');
		h.setEffort("auto");
		expect(h.status().effort).toBeUndefined();
		expect(readFileSync(userFile, "utf8")).not.toContain('effort =');
		expect(() => h.setEffort("不合法!")).toThrow("不合法");
		await h.close();
	});
});

describe("preset 三态现算（m5 T9 设计空白 17——modpreset 纯函数）", () => {
	const audit = (states: Record<string, string>) => Object.entries(states).map(([name, state]) => ({ name, state }));
	const baseline = presetBaseline("prov-a");

	it("③ 全启用（含非保底模块）= full；只剩保底 = minimal；中间态 = custom", () => {
		expect(computeModulePreset(audit({ "orosus-core": "active", approval: "active", "prov-a": "active", "tool-fs": "active" }), baseline)).toBe("full");
		expect(computeModulePreset(audit({ "orosus-core": "active", approval: "active", "prov-a": "active", "tool-fs": "discovered" }), baseline)).toBe("minimal");
		expect(computeModulePreset(audit({ "orosus-core": "active", approval: "active", "prov-a": "active", "tool-fs": "active", "tool-web": "discovered" }), baseline)).toBe("custom");
	});

	it("④ 模块全集恰为保底名单且全启用 = minimal（更具体的档位优先）", () => {
		expect(computeModulePreset(audit({ "orosus-core": "active", approval: "active", "prov-a": "active" }), baseline)).toBe("minimal");
	});
});

describe("applyModulePreset 计划器（m5 T10——设计空白 9/10/16 + 决策点 21 纯计算面）", () => {
	const active = ["orosus-core", "approval", "prov-a", "tool-fs", "tool-web"];
	const baseline = presetBaseline("prov-a");

	it("⑤ minimal：关闭集 = 启用 − 保底（核心/审批/当前 provider 留下）", () => {
		const plan = planModulePreset({ preset: "minimal", activeNames: active, baseline, minimalClosed: undefined });
		expect(plan.writes.map((w) => `${w.name}:${w.enable}`)).toEqual(["tool-fs:false", "tool-web:false"]);
	});

	it("⑥ minimal 幂等：关闭集空（已在极简态）→ 空计划 + already-minimal——调用方保留原记录不覆盖", () => {
		const plan = planModulePreset({ preset: "minimal", activeNames: ["orosus-core", "approval", "prov-a"], baseline, minimalClosed: new Set(["tool-fs"]) });
		expect(plan.writes).toEqual([]);
		expect(plan.note).toBe("already-minimal");
	});

	it("⑦ full 恢复语义：只恢复极简自己关掉的那批；从未切过 = 无操作", () => {
		const plan = planModulePreset({ preset: "full", activeNames: active, baseline, minimalClosed: new Set(["tool-fs", "tool-web"]) });
		expect(plan.writes.map((w) => `${w.name}:${w.enable}`)).toEqual(["tool-fs:true", "tool-web:true"]);
		const never = planModulePreset({ preset: "full", activeNames: active, baseline, minimalClosed: undefined });
		expect(never.writes).toEqual([]);
		expect(never.note).toBe("nothing-to-restore");
	});
});
