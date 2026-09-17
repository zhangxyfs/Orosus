import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { loadConfig, loadSecretsEnv, mergeEnvLayer } from "./load.ts";
import { resolveSections } from "./validate.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mod = (name: string, extra: Parameters<typeof defineModule>[0] extends infer T ? Partial<T> : never) =>
  defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });

describe("分层合并（§6.6：默认→用户→项目→env→flag）", () => {
  it("后者覆盖前者；env 仅覆盖核心顶层 key", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cfg-"));
    writeFileSync(join(dir, "user.toml"), `model = "anthropic/a"\n[tool-fs]\nmaxFileSize = "1MB"\n`);
    writeFileSync(join(dir, "proj.toml"), `model = "anthropic/b"\n`);
    const cfg = loadConfig({
      userFile: join(dir, "user.toml"),
      projectFile: join(dir, "proj.toml"),
      cliOverrides: { model: "anthropic/c" },
      env: { OROSUS_MODEL: "anthropic/env", OROSUS_IGNORED: "x" },
    });
    expect(cfg.core.model).toBe("anthropic/c"); // CLI 最高
    expect(cfg.sections.get("tool-fs")).toEqual({ maxFileSize: "1MB" });
    expect(cfg.sections.get("approval")).toEqual({ required: true }); // 出厂默认层（M3 前属未来配置）
    expect(cfg.core.OROSUS_IGNORED).toBeUndefined();
  });

  it("env 层在无 CLI 覆盖时生效于核心顶层 key", () => {
    const cfg = loadConfig({ env: { OROSUS_MODEL: "openai/gpt-x" } });
    expect(cfg.core.model).toBe("openai/gpt-x");
  });

  it("UTF-8 BOM 的配置文件可解析（Windows PowerShell 5.1 Out-File -Encoding utf8 会写 BOM）", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cfg-"));
    writeFileSync(join(dir, "bom.toml"), `\uFEFFmodel = "anthropic/bom"\n`);
    const cfg = loadConfig({ userFile: join(dir, "bom.toml"), env: {} });
    expect(cfg.core.model).toBe("anthropic/bom");
  });

  it("$ENV:VAR 占位解析期替换；缺失变量保留占位并出 warning", () => {
    const cfg = loadConfig({
      cliOverrides: {},
      env: { MY_KEY: "sk-123" },
    });
    expect(cfg.warnings).toEqual([]);
    const cfg2 = loadConfig({ env: {} });
    const cfg3 = loadConfig({
      env: { MY_KEY: "sk-123" },
      cliOverrides: { note: "$ENV:MY_KEY" },
    });
    expect(cfg3.core.note).toBe("sk-123");
    const cfg4 = loadConfig({ env: {}, cliOverrides: { note: "$ENV:MISSING_VAR" } });
    expect(cfg4.core.note).toBe("$ENV:MISSING_VAR");
    expect(cfg4.warnings.some((w) => w.includes("MISSING_VAR"))).toBe(true);
    void cfg2;
  });
});

describe("section 校验（§6.6 单区制 + 保留 key + strict）", () => {
  it("enabled 三层优先级：CLI > 配置 > defaultEnabled；--no-modules 纯净模式", () => {
    const defs = [mod("a", { defaultEnabled: false }), mod("b", {}), mod("c", {})];
    const sections = new Map<string, Record<string, unknown>>([["b", { enabled: false }]]);
    const r = resolveSections(sections, defs, { enable: ["a"], disable: ["c"] });
    expect(r.isEnabled(defs[0]!)).toBe(true);  // CLI enable 覆盖 defaultEnabled: false
    expect(r.isEnabled(defs[1]!)).toBe(false); // 配置禁用
    expect(r.isEnabled(defs[2]!)).toBe(false); // CLI disable
    const pure = resolveSections(new Map(), defs, { noModules: true, module: ["b"] });
    expect(pure.isEnabled(defs[0]!)).toBe(false);
    expect(pure.isEnabled(defs[1]!)).toBe(true);
    // --enable-module 在纯净模式下不生效（§5.4：纯净模式只认 --module）
    const pure2 = resolveSections(new Map(), defs, { noModules: true, enable: ["b"] });
    expect(pure2.isEnabled(defs[1]!)).toBe(false);
  });

  it("保留 key 剥离后过模块 schema；未知 key 报错（strict）", () => {
    const m = mod("tool-fs", { config: z.object({ maxFileSize: z.string().default("10MB") }) });
    const sections = new Map<string, Record<string, unknown>>([
      ["tool-fs", { enabled: true, required: false, maxFileSize: "5MB" }],
    ]);
    const r = resolveSections(sections, [m], {});
    const c = r.configFor(m);
    expect(c).toEqual({ ok: true, value: { maxFileSize: "5MB" } });
    const bad = resolveSections(new Map([["tool-fs", { typoKey: 1 }]]), [m], {});
    const c2 = bad.configFor(m);
    expect(c2.ok).toBe(false);
    if (!c2.ok) expect(c2.error).toContain("typoKey");
  });

  it("孤儿 section → warning 不阻断；无 schema 的模块拒收额外 key", () => {
    const m = mod("a", {});
    const r = resolveSections(new Map([["ghost", { x: 1 }], ["a", { extra: 1 }]]), [m], {});
    expect(r.orphanSections).toEqual(["ghost"]);
    const c = r.configFor(m);
    expect(c.ok).toBe(false);
  });
});

describe("secrets.env（D37）", () => {
  it("loadSecretsEnv：KEY=VALUE 解析，坏行跳过不炸；mergeEnvLayer：process 覆盖 secrets、secrets 补缺", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-sec-"));
    const f = join(dir, "secrets.env");
    writeFileSync(f, "A=1\nBADLINE\n=2\nB=2\n# comment\n");
    const { vars, badLines } = loadSecretsEnv(f);
    expect(vars).toEqual({ A: "1", B: "2" });
    expect(badLines).toBeGreaterThan(0);
    expect(mergeEnvLayer({ X: "proc" }, { X: "sec", Y: "sec" })).toEqual({ X: "proc", Y: "sec" });
    expect(mergeEnvLayer({}, { Z: "s" })).toEqual({ Z: "s" });
  });
});
