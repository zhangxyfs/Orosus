import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { loadConfig, loadSecretsEnv, mergeEnvLayer, modelsDevCacheFile, lookupModelsDevContextWindow, resolveContextWindow } from "./load.ts";
import { resolveSections } from "./validate.ts";

/** [provider-custom] sections 构造件（条目级 contextWindow 用例）：给定条目窗口值 → sections Map。 */
const sec = (cw: unknown): Map<string, Record<string, unknown>> =>
  new Map([["provider-custom", { providers: { "zhipuai-coding-plan": { defaultModel: "glm-5.3", contextWindow: cw } } }]]);

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

  it("CH-06 回归钉：camelCase 核心键经 OROSUS_* 可达（OROSUS_CONTEXTWINDOW→contextWindow、OROSUS_SESSIONSTORE→sessionStore）；表外未知键仍按小写透传", () => {
    const cfg = loadConfig({ env: {
      OROSUS_CONTEXTWINDOW: "65536",
      OROSUS_SESSIONSTORE: "sqlite",
      OROSUS_MODEL: "x/m",
      OROSUS_UNKNOWNKEY: "v",
    } });
    expect(cfg.core.contextWindow).toBe("65536"); // 旧实现落 contextwindow——读侧 camelCase 恒 undefined（静默无效）
    expect(cfg.core.sessionStore).toBe("sqlite");
    expect(cfg.core.model).toBe("x/m"); // 全小写键行为不变
    expect(cfg.core.unknownkey).toBe("v"); // 开放面维持：表外键原样小写
  });

  it("UTF-8 BOM 的配置文件可解析（Windows PowerShell 5.1 Out-File -Encoding utf8 会写 BOM）", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cfg-"));
    writeFileSync(join(dir, "bom.toml"), `﻿model = "anthropic/bom"\n`);
    const cfg = loadConfig({ userFile: join(dir, "bom.toml"), env: {} });
    expect(cfg.core.model).toBe("anthropic/bom");
  });

  it("坏 TOML 不炸穿启动（SW-20）：解析失败层跳过 + warnings 留痕，其余层照常生效", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cfg-"));
    writeFileSync(join(dir, "bad.toml"), `model = "anthropic/x"\n[unclosed\n`);
    writeFileSync(join(dir, "good.toml"), `contextWindow = 4096\n`);
    const cfg = loadConfig({ userFile: join(dir, "bad.toml"), projectFile: join(dir, "good.toml"), env: {} });
    expect(cfg.core.model).toBeUndefined(); // 坏层被跳过（此前 parse 抛错 = 启动即崩）
    expect(cfg.core.contextWindow).toBe(4096); // 好层照常
    expect(cfg.warnings.some((w) => w.includes("bad.toml") && w.includes("解析失败"))).toBe(true);
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

  it("CH-07 回归钉：section 嵌套对象跨层深合并——项目层加一个 provider 不再整键替换用户层 providers 表", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cfg-"));
    writeFileSync(join(dir, "user.toml"), `[provider-custom.providers.zhipuai]\napiKey = "u1"\n[provider-custom.providers.openai]\napiKey = "u2"\n`);
    writeFileSync(join(dir, "proj.toml"), `[provider-custom.providers.projonly]\napiKey = "p1"\n`);
    const cfg = loadConfig({ userFile: join(dir, "user.toml"), projectFile: join(dir, "proj.toml"), env: {} });
    expect((cfg.sections.get("provider-custom") as Record<string, unknown>).providers).toEqual({
      zhipuai: { apiKey: "u1" },
      openai: { apiKey: "u2" },
      projonly: { apiKey: "p1" }, // 旧实现（单层 spread）：用户层两家被项目层整键替换——静默丢失
    });
  });

  it("CH-07 回归钉·口径：标量与数组仍整值替换（数组不拼接）、嵌套标量覆盖、下层独有嵌套键保留", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cfg-"));
    writeFileSync(join(dir, "user.toml"), `[m]\nlist = [1, 2]\nkeep = "u"\n[m.inner]\na = 1\nb = "user-b"\n`);
    writeFileSync(join(dir, "proj.toml"), `[m]\nlist = [3]\n[m.inner]\na = 2\n`);
    const cfg = loadConfig({ userFile: join(dir, "user.toml"), projectFile: join(dir, "proj.toml"), env: {} });
    const m = cfg.sections.get("m") as Record<string, unknown>;
    expect(m.list).toEqual([3]); // 数组替换（拼接口径未采纳——无消费方需要，去重/序是新问题）
    expect(m.keep).toBe("u"); // 标量：下层独有保留
    expect(m.inner).toEqual({ a: 2, b: "user-b" }); // 嵌套对象：逐键覆盖而非整表替换
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

  it("CH-14② 回归钉：非 instanceof z.ZodObject 的 schema（jiti 双 zod 副本形态——鸭式 safeParse）同样做 strict 未知 key 检查", () => {
    // 模拟 local 模块自带另一份 zod 的形态：有 safeParse 但不是本进程 z.ZodObject 实例
    const duckSchema = {
      safeParse(input: unknown) {
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) if (k === "known") data[k] = v; // strip 语义：未知 key 不进 data
        return { success: true as const, data };
      },
    };
    const m = mod("duck", { config: duckSchema as never });
    const bad = resolveSections(new Map([["duck", { known: 1, typoKey: 2 }]]), [m], {});
    const c = bad.configFor(m);
    expect(c.ok).toBe(false); // 旧实现：instanceof 假 → strict 检查静默跳过 → ok:true、typoKey 被 strip 吞掉
    if (!c.ok) expect(c.error).toContain("typoKey");
    const ok = resolveSections(new Map([["duck", { known: 1 }]]), [m], {});
    expect(ok.configFor(m)).toEqual({ ok: true, value: { known: 1 } });
  });

  it("CH-14① 回归钉：enabled 非布尔（手误字符串/数字）→ warnings 留痕且按未写处理；布尔值不出 warning", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cfg-"));
    writeFileSync(join(dir, "user.toml"), `[m]\nenabled = "false"\n[n]\nenabled = 1\n[ok]\nenabled = false\n`);
    const cfg = loadConfig({ userFile: join(dir, "user.toml"), env: {} });
    expect(cfg.warnings.some((w) => w.includes("[m]") && w.includes("enabled"))).toBe(true); // 旧实现：typeof 守卫静默忽略、零提示
    expect(cfg.warnings.some((w) => w.includes("[n]") && w.includes("enabled"))).toBe(true);
    expect(cfg.warnings.some((w) => w.includes("[ok]"))).toBe(false); // 布尔值合法——不出 warning
    const defs = [mod("m", {}), mod("n", {}), mod("ok", {})];
    const r = resolveSections(cfg.sections, defs, {});
    expect(r.isEnabled(defs[0]!)).toBe(true); // 非布尔被忽略 → 回 defaultEnabled（判定口径不变）
    expect(r.isEnabled(defs[2]!)).toBe(false); // 真布尔照常生效
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

  it("CH-15 回归钉：值剥成对单/双引号（dotenv 心智手编辑 KEY=\"v\"——旧实现值带引号进适配器 → 密钥静默 401）；不成对引号原样；空引号对 = 空串", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-sec-"));
    const f = join(dir, "secrets.env");
    writeFileSync(f, 'A="sk-1"\nB=\'sk-2\'\nC=sk-3\nD="单边\nE=""\n');
    const { vars } = loadSecretsEnv(f);
    expect(vars).toEqual({ A: "sk-1", B: "sk-2", C: "sk-3", D: '"单边', E: "" });
  });
});

describe("contextWindow 解析链（2026-09-29 用户拍板：config 显式值 > models-dev 目录兜底）", () => {
  let seq = 0;
  const writeCatalog = (catalog: unknown): string => {
    const file = join(dir, `models-dev-${seq++}.json`); // 每次新文件——mtime 记忆化不串场
    writeFileSync(file, JSON.stringify({ fetchedAt: 1, catalog }), "utf8");
    return file;
  };
  const CATALOG = {
    "zhipuai-coding-plan": { name: "智谱编码", models: { "glm-5.3": { limit: { context: 1_000_000 } } } }, // key 口径
    zhipu: { name: "智谱", models: { "glm-4.6": { id: "glm-4.6", limit: { context: 200_000 } } } }, // id 口径
    openrouter: { models: { "zhipu/glm-4.5": { limit: { context: 128_000 } } } }, // 嵌斜杠 key 尾段口径
  };

  it("lookupModelsDevContextWindow：key/id/尾段三口径命中；「槽/模型」全名取首斜杠后段；未命中/缺文件/坏 JSON/limit 非法 → undefined；同模型异条目取有效者", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cw-"));
    const file = writeCatalog(CATALOG);
    expect(lookupModelsDevContextWindow(file, "glm-5.3")).toBe(1_000_000);
    expect(lookupModelsDevContextWindow(file, "zhipuai-coding-plan/glm-5.3")).toBe(1_000_000);
    expect(lookupModelsDevContextWindow(file, "glm-4.6")).toBe(200_000);
    expect(lookupModelsDevContextWindow(file, "zhipu/glm-4.5")).toBe(128_000);
    expect(lookupModelsDevContextWindow(file, "nope/m")).toBeUndefined();
    expect(lookupModelsDevContextWindow(file, "")).toBeUndefined();
    expect(lookupModelsDevContextWindow(join(dir, "absent.json"), "glm-5.3")).toBeUndefined();
    const bad = join(dir, `bad-${seq++}.json`);
    writeFileSync(bad, "{oops", "utf8");
    expect(lookupModelsDevContextWindow(bad, "glm-5.3")).toBeUndefined();
    // 命中但该条目 limit.context 非法（0）→ 继续搜；同厂异门另一条目有效 → 取到
    const two = writeCatalog({ a: { models: { "x1": { limit: { context: 0 } } } }, b: { models: { "x1": { limit: { context: 65536 } } } } });
    expect(lookupModelsDevContextWindow(two, "x1")).toBe(65536);
    // 全条目都无有效 limit → undefined
    const none = writeCatalog({ a: { models: { "x2": { limit: { context: "大" } } } } });
    expect(lookupModelsDevContextWindow(none, "x2")).toBeUndefined();
  });

  it("resolveContextWindow：显式正整数/纯数字串优先；非法显式 → onIllegal 后走目录兜底；无 model 或无 catalogFile 不查表", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cw-r-"));
    const file = writeCatalog(CATALOG);
    expect(resolveContextWindow({ contextWindow: 65536, provider: "zhipuai-coding-plan/glm-5.3" }, { catalogFile: file })).toBe(65536); // 显式赢目录
    expect(resolveContextWindow({ contextWindow: "409600" }, { catalogFile: file })).toBe(409600); // env 层数字串等价（CH-06 连带）
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan/glm-5.3" }, { catalogFile: file })).toBe(1_000_000); // 兜底命中（provider 槽/模型口径）
    expect(resolveContextWindow({ model: "glm-4.6" }, { catalogFile: file })).toBe(200_000); // core.model 口径
    const illegal: unknown[] = [];
    expect(resolveContextWindow({ contextWindow: 0, provider: "zhipuai-coding-plan/glm-5.3" }, { catalogFile: file, onIllegal: (v) => illegal.push(v) })).toBe(1_000_000); // 非法显式不挡兜底
    expect(illegal).toEqual([0]);
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan/glm-5.3" })).toBeUndefined(); // 未给 catalogFile = 不查表（纯读面）
    expect(resolveContextWindow({}, { catalogFile: file })).toBeUndefined(); // 无 model 不查表
  });

  it("resolveContextWindow（2026-10-08 修）：裸槽名经 sections 的 defaultModel 解出真模型查表；provider 键优先于遗留 model 键；lookup 槽精确优先", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cw-dm-"));
    const file = writeCatalog(CATALOG);
    const sections = new Map([["provider-custom", { providers: { "zhipuai-coding-plan": { defaultModel: "glm-5.3" } } }]]);
    // 实机回归钉：model 只写在 [provider-custom] 槽 defaultModel（顶层 provider 裸槽名）——旧口径拿槽名
    // 当模型名查表恒 miss → undefined → 压缩 60k 平阈值 + 面板 200k 假窗
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan" }, { catalogFile: file, sections })).toBe(1_000_000);
    // 调用方未透传 sections（旧调用面）→ 仍拿槽名宽搜 miss（不猜）
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan" }, { catalogFile: file })).toBeUndefined();
    // provider 键优先（请求链 cfgModelValue 同口径——/model 持久化只写 provider 键、旧 model 行清除）
    expect(resolveContextWindow({ provider: "zhipu/glm-4.6", model: "glm-5.3" }, { catalogFile: file, sections })).toBe(200_000);
    // defaultModel 坏形状（空串）不解析 → 拿原值宽搜 miss → undefined
    const badSections = new Map([["provider-custom", { providers: { "zhipuai-coding-plan": { defaultModel: "" } } }]]);
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan" }, { catalogFile: file, sections: badSections })).toBeUndefined();
    // lookup 槽精确优先：同模型名跨条目窗口不同，slot 在场取本槽条目；槽条目不存在回落宽搜（既有行为）
    const two = writeCatalog({ a: { models: { m1: { limit: { context: 8192 } } } }, b: { models: { m1: { limit: { context: 65536 } } } } });
    expect(lookupModelsDevContextWindow(two, "m1", "b")).toBe(65536);
    expect(lookupModelsDevContextWindow(two, "m1", "a")).toBe(8192);
    expect(lookupModelsDevContextWindow(two, "m1")).toBe(8192);
    expect(lookupModelsDevContextWindow(two, "m1", "absent-slot")).toBe(8192);
  });

  it("resolveContextWindow 条目级 contextWindow（2026-10-09 拍板③）：[provider-custom.providers.<槽>] 配了就用（赢目录、无需 catalogFile）；顶层显式仍最高；非法条目值走目录；纯数字串等价", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cw-entry-"));
    const file = writeCatalog(CATALOG);
    // 条目赢目录（目录说 glm-5.3 = 1M，条目 262144 生效）——私有端点模型的手兜底位
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan" }, { catalogFile: file, sections: sec(262144) })).toBe(262144);
    // 纯配置面：无 catalogFile 也生效（不依赖目录数据）；纯数字串等价（与顶层显式值 CH-06 同规）
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan" }, { sections: sec("262144") })).toBe(262144);
    // 顶层显式值仍最高（import 链对当前模型的钉值 > 条目级默认）
    expect(resolveContextWindow({ contextWindow: 131072, provider: "zhipuai-coding-plan" }, { catalogFile: file, sections: sec(262144) })).toBe(131072);
    // 非法条目值（0）→ 忽略走目录
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan" }, { catalogFile: file, sections: sec(0) })).toBe(1_000_000);
    // 「槽/模型」全形也吃条目级（槽命中即用）
    expect(resolveContextWindow({ provider: "zhipuai-coding-plan/glm-5.3" }, { catalogFile: file, sections: sec(65536) })).toBe(65536);
  });

  it("modelsDevCacheFile：宿主 cache 目录落点（provider-custom defaultCatalogCacheFile 同款路径）", () => {
    expect(modelsDevCacheFile(join("h", "home"))).toBe(join("h", "home", "cache", "models-dev.json"));
  });
});
