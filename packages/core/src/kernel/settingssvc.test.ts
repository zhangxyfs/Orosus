import { describe, it, expect } from "vitest";
import { defineModule, type HostInfo, type ModuleDefinition, type SettingsService } from "@orosus/contracts/module";
import { InMemorySessionStore } from "../session/memory.ts";
import { loadModules } from "./kernel.ts";
import type { DiagSink } from "../diag/logger.ts";

/** m5 T9：ctx.settings 装配（mounts "settings" 门）与 ctx.host 直挂（无门）——照 ctx.tools 缝模式。 */

const sink = (): DiagSink => ({ write: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() });

const load = async (over: { settings?: SettingsService; host?: HostInfo; modules?: ModuleDefinition[] } = {}) =>
  loadModules({
    defs: (over.modules ?? []).map((def) => ({ def, source: "builtin" as const })),
    cli: {},
    sections: new Map(),
    session: new InMemorySessionStore(),
    sink: sink(),
    spillDir: "/tmp/s",
    ...(over.settings !== undefined ? { settings: over.settings } : {}),
    ...(over.host !== undefined ? { host: over.host } : {}),
  });

describe("ctx.settings / ctx.host 装配（m5 T9 口子四）", () => {
	const svc: SettingsService = {
		setModel: async (q) => { calls.push(`model:${q}`); },
		setEffort: async (l) => { calls.push(`effort:${l}`); },
		setTheme: async () => { calls.push("theme"); },
		applyModulePreset: async () => ({ failed: [] }),
		setLabel: async () => { calls.push("label"); },
	};
	const calls: string[] = [];

	it("① mounts 门：未列 \"settings\" 调用即抛 → 模块降级；列了 → 透传到实现", async () => {
		const g = await load({
			settings: svc,
			modules: [
				defineModule({ name: "s-gated", version: "0.0.1", description: "x", api: 1, mounts: ["contribute:tool"], activate(ctx) { void ctx.settings?.setModel("a/b"); } }),
			],
		});
		expect(g.audit().find((a) => a.name === "s-gated")!.state).toBe("failed");
		expect(g.audit().find((a) => a.name === "s-gated")!.failReason).toContain("settings");
		await g.dispose();

		const ok = await load({
			settings: svc,
			modules: [
				defineModule({ name: "s-ok", version: "0.0.1", description: "x", api: 1, mounts: ["settings"], activate(ctx) { void ctx.settings!.setModel("a/b"); } }),
			],
		});
		expect(ok.audit().find((a) => a.name === "s-ok")!.state).toBe("active");
		expect(calls).toContain("model:a/b");
		await ok.dispose();
	});

	it("② ctx.host 无门直挂：模块不声明 mounts 也读得（读不占写闸——决策点 24）", async () => {
		const snap = { model: "x/y", modelOverridden: false, preset: "full", theme: "连山", permission: "ask-risky", usage: { current: { input: 0, output: 0 } } } as const;
		const host: HostInfo = { current: async () => snap };
		let got: string | undefined;
		const g = await load({
			host,
			modules: [
				defineModule({ name: "h-read", version: "0.0.1", description: "x", api: 1, async activate(ctx) { got = (await ctx.host?.current())?.model; } }),
			],
		});
		expect(g.audit().find((a) => a.name === "h-read")!.state).toBe("active");
		expect(got).toBe("x/y");
		await g.dispose();
	});

	it("③ 老宿主（两项都不注入）：ctx.settings 与 ctx.host 双 undefined——判空降级", async () => {
		let settings: unknown = "unset";
		let host: unknown = "unset";
		const g = await load({
			modules: [
				defineModule({ name: "bare", version: "0.0.1", description: "x", api: 1, activate(ctx) { settings = ctx.settings; host = ctx.host; } }),
			],
		});
		expect(settings).toBeUndefined();
		expect(host).toBeUndefined();
		expect(g.audit().every((a) => a.state === "active")).toBe(true);
		await g.dispose();
	});
});
