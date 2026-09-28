import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore, trustModule } from "@orosus/core";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const md = (p: string) => mkdirSync(p, { recursive: true });

describe("信任门端到端（T20）：项目级 fail-closed 拦截 + 真 hash 登记放行", () => {
  // TS-01 回归钉背景：原断言 `state === "pending-confirm" || state === "active"` 析取恒真——
  // 信任门若退化成「登记即过、不验 hash」（被穿透）该测试照样绿。拆成两个互斥方向分别钉死单态。
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-trust-")); dirs.push(dir);
    md(join(dir, "mods", "proj-mod"));
    writeFileSync(join(dir, "mods", "proj-mod", "index.ts"), `import { defineModule } from "@orosus/contracts/module";
export default defineModule({ name: "proj-mod", version: "0.1.0", description: "d", api: 1, activate() {} });
`);
    const trustFile = join(dir, "trust.json");
    const boot = () => createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      discovery: { userDir: join(dir, "no-user"), projectDir: join(dir, "mods"), trustFile },
      config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {} },
    });
    return { dir, trustFile, boot };
  };

  it("TS-01 拦截方向：登记 hash 与入口不匹配（hash-changed）→ 仍拦（pending-confirm 单态，reason 带「变更」）", async () => {
    const { dir, trustFile, boot } = setup();
    const h1 = await boot();
    expect(h1.graph().records.find((r) => r.name === "proj-mod")?.state).toBe("pending-confirm"); // m5 T17：待确认桶（原 failed(untrusted)——不进 failed 计数）
    await h1.close();
    // 登记一个必然不匹配的 hash → 重启后仍拦（hash-changed → 待确认桶带「代码已变更」）
    trustModule(trustFile, join(dir, "mods", "proj-mod"), "placeholder");
    const h2 = await boot();
    const rec = h2.graph().records.find((r) => r.name === "proj-mod");
    expect(rec?.state).toBe("pending-confirm"); // 单态钉死：不匹配 = 拦（原析取式在「错误放行为 active」时也绿）
    expect(rec?.failReason ?? h2.pendingConfirms().find((p) => p.name === "proj-mod")?.reason ?? "").toContain("变更"); // hash-changed 文案
    await h2.close();
  });

  it("TS-01 放行方向：用发现管线算出的真 hash 登记 → 重启后激活（原套件项目级「信任→激活」方向零覆盖）", async () => {
    const { trustFile, boot } = setup();
    const h1 = await boot();
    const pending = h1.pendingConfirms().find((p) => p.name === "proj-mod")!; // 首挂弹窗的数据源——entryHash 由发现管线算出
    expect(pending).toBeDefined();
    expect(pending.layer).toBe("project");
    trustModule(trustFile, pending.root, pending.entryHash); // 真 hash 入册
    await h1.close();
    const h2 = await boot();
    expect(h2.graph().records.find((r) => r.name === "proj-mod")?.state).toBe("active"); // 单态钉死：匹配 = 放行
    await h2.close();
  });
});

describe("首挂确认流（m5 T17——用户级一次性确认 + 确认→reload 链通 + 不追 hash）", () => {
	it("用户级未确认 → pendingConfirms 带 layer/root/entryHash → trustModule 登记 → 同 harness reload 即挂载；此后改内容不重问", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orosus-confirm-")); dirs.push(dir);
		md(join(dir, "umods", "note"));
		const entry = join(dir, "umods", "note", "index.ts");
		writeFileSync(entry, `import { defineModule } from "@orosus/contracts/module";
export default defineModule({ name: "note", version: "0.1.0", description: "d", api: 1, activate() {} });
`);
		const trustFile = join(dir, "trust.json");
		const h = await createHarness({
			store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
			discovery: { userDir: join(dir, "umods"), projectDir: join(dir, "no-proj"), trustFile },
			config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {} },
		});
		expect(h.graph().records.find((r) => r.name === "note")?.state).toBe("pending-confirm"); // 默认非挂载
		const pending = h.pendingConfirms().find((p) => p.name === "note")!;
		expect(pending).toBeDefined();
		expect(pending.layer).toBe("user");
		expect(pending.root).toContain("note");
		expect(pending.entryHash).not.toBe("");
		expect(pending.def.name).toBe("note"); // 声明面数据源
		// 确认三动作的内核件：登记（用户级认登记）→ reload → 挂载
		trustModule(trustFile, pending.root, pending.entryHash);
		await h.reload();
		expect(h.graph().records.find((r) => r.name === "note")?.state).toBe("active");
		expect(h.pendingConfirms()).toHaveLength(0); // 出桶
		// 不追 hash：改入口内容 → reload 不回桶
		writeFileSync(entry, `import { defineModule } from "@orosus/contracts/module";
export default defineModule({ name: "note", version: "0.2.0", description: "d", api: 1, activate() {} });
`);
		await h.reload();
		expect(h.graph().records.find((r) => r.name === "note")?.state).toBe("active"); // 登记还在——自己地盘改动不烦
		await h.close();
	});
});
