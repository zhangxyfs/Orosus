import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModules } from "./discover.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = mkdtempSync(join(tmpdir(), "orosus-disc-")); dirs.push(d); return d; };
const md = (p: string) => mkdirSync(p, { recursive: true });

const MODULE_SRC = (name: string) => `import { defineModule } from "@orosus/contracts/module";
import { FS } from "@orosus/contracts/fs";
export default defineModule({ name: "${name}", version: "0.1.0", description: "d", api: 1, provides: [FS], activate() {} });
`;

const sink = { write: () => {}, flush: async () => {}, close: async () => {} } as never;

describe("目录扫描与 jiti 加载（§8.3/§8.4，含 §8.2 路径 source）", () => {
  it("① 用户级目录：package.json 带 orosus.module:true + exports → 按 exports 入口加载", async () => {
    const user = mk();
    md(join(user, "mods", "m-pkg"));
    writeFileSync(join(user, "mods", "m-pkg", "package.json"), JSON.stringify({ name: "m-pkg", orosus: { module: true }, exports: { "./module": "./src/entry.ts" } }));
    md(join(user, "mods", "m-pkg", "src"));
    writeFileSync(join(user, "mods", "m-pkg", "src", "entry.ts"), MODULE_SRC("m-pkg"));
    const found = await discoverModules({ userDir: join(user, "mods"), projectDir: join(user, "none"), sink });
    expect(found.map((f) => f.def.name)).toEqual(["m-pkg"]);
    expect(found[0]!.source).toBe("local");
    expect(found[0]!.entryHash).toHaveLength(64);
  });

  it("② 无 package.json 的 index.ts 目录 → 加载", async () => {
    const user = mk();
    md(join(user, "mods", "m-idx"));
    writeFileSync(join(user, "mods", "m-idx", "index.ts"), MODULE_SRC("m-idx"));
    const found = await discoverModules({ userDir: join(user, "mods"), projectDir: join(user, "none"), sink });
    expect(found.map((f) => f.def.name)).toEqual(["m-idx"]);
  });

  it("③ 不递归（嵌套子目录忽略）", async () => {
    const user = mk();
    md(join(user, "mods", "outer", "inner"));
    writeFileSync(join(user, "mods", "outer", "index.ts"), MODULE_SRC("outer"));
    writeFileSync(join(user, "mods", "outer", "inner", "index.ts"), MODULE_SRC("inner"));
    const found = await discoverModules({ userDir: join(user, "mods"), projectDir: join(user, "none"), sink });
    expect(found.map((f) => f.def.name)).toEqual(["outer"]);
  });

  it("④ 空目录 / 非模块目录（无入口）→ 跳过并 warn", async () => {
    const user = mk();
    md(join(user, "mods", "empty"));
    md(join(user, "mods", "noentry"));
    writeFileSync(join(user, "mods", "noentry", "readme.md"), "x");
    const warns: string[] = [];
    const s = { write: (r: { lvl: string; msg: string }) => { if (r.lvl === "warn") warns.push(r.msg); }, flush: async () => {}, close: async () => {} } as never;
    const found = await discoverModules({ userDir: join(user, "mods"), projectDir: join(user, "none"), sink: s });
    expect(found).toHaveLength(0);
    expect(warns.length).toBeGreaterThan(0);
  });

  it("⑤ jiti alias：外部模块 import @orosus/contracts/* 成功且符号行为等价（已知限制：contracts 无 instanceof 词汇，双实例不可观察）", async () => {
    const user = mk();
    md(join(user, "mods", "m-alias"));
    writeFileSync(join(user, "mods", "m-alias", "index.ts"), `import { defineModule } from "@orosus/contracts/module";
import { FS } from "@orosus/contracts/fs";
export default defineModule({ name: "m-alias", version: "0.1.0", description: "d", api: 1, provides: [FS], activate() {} });
`);
    const found = await discoverModules({ userDir: join(user, "mods"), projectDir: join(user, "none"), sink });
    expect(found[0]!.def.name).toBe("m-alias");
    expect(found[0]!.def.provides).toEqual(["fs"]); // provides 由 alias 导入的 FS 填充——alias 生效的可观察证据
  });

  it("⑥ 加载制品非 defineModule 形状 → 抛『非模块制品』降级", async () => {
    const user = mk();
    md(join(user, "mods", "m-bad"));
    writeFileSync(join(user, "mods", "m-bad", "index.ts"), "export default { nope: true };\n");
    const errors: string[] = [];
    const s = { write: (r: { lvl: string; msg: string }) => { if (r.lvl === "warn") errors.push(r.msg); }, flush: async () => {}, close: async () => {} } as never;
    const found = await discoverModules({ userDir: join(user, "mods"), projectDir: join(user, "none"), sink: s });
    expect(found).toHaveLength(0);
    expect(errors.join("\n")).toContain("非模块制品");
  });

  it("⑦ 配置声明的路径 source（§8.2）：./ 相对配置文件目录 → 同一加载管线，source local", async () => {
    const proj = mk();
    md(join(proj, "scripts", "my-module"));
    writeFileSync(join(proj, "scripts", "my-module", "index.ts"), MODULE_SRC("my-module"));
    md(join(proj, ".orosus"));
    writeFileSync(join(proj, ".orosus", "config.toml"), '[my-module]\nsource = "../scripts/my-module"\n');
    const found = await discoverModules({ userDir: join(proj, "no-user"), projectDir: join(proj, ".orosus"), sink });
    expect(found.map((f) => f.def.name)).toEqual(["my-module"]);
    expect(found[0]!.layer).toBe("project");
  });

  it("⑧ 路径 source 信任分层：出现在用户配置 → layer user；项目配置 → layer project（后续信任门按 layer 判定）", async () => {
    const home = mk();
    md(join(home, "scripts", "u-mod"));
    writeFileSync(join(home, "scripts", "u-mod", "index.ts"), MODULE_SRC("u-mod"));
    writeFileSync(join(home, "config.toml"), '[u-mod]\nsource = "./scripts/u-mod"\n');
    const found = await discoverModules({ userDir: join(home, "no"), projectDir: join(home, "no"), userFile: join(home, "config.toml"), sink });
    expect(found.map((f) => f.def.name)).toEqual(["u-mod"]);
    expect(found[0]!.layer).toBe("user");
  });

  // T5 加载期补口：坏包/坏入口不炸启动——异常止于 discover 层（跳过 + warn），不穿 createHarness
  const capturingSink = () => {
    const recs: { lvl: string; code: string; msg: string; data?: Record<string, unknown> }[] = [];
    return { recs, sink: { write: (r: (typeof recs)[number]) => { recs.push(r); }, flush: async () => {}, close: async () => {} } as never };
  };

  it("⑨ 目录扫描：坏 JSON 的 package.json → 跳过不抛，warn 含「包描述读取失败」+ 目录名 + data.module", async () => {
    const user = mk();
    md(join(user, "mods", "bad-json"));
    writeFileSync(join(user, "mods", "bad-json", "package.json"), "{ 这不是合法 JSON !!");
    const { recs, sink: s } = capturingSink();
    const found = await discoverModules({ userDir: join(user, "mods"), projectDir: join(user, "none"), sink: s });
    expect(found).toHaveLength(0);
    const skip = recs.find((r) => r.code === "kernel.discover.skip");
    expect(skip).toBeDefined();
    expect(skip!.msg).toContain("包描述读取失败"); // S3 机械判据锚公共子串「读取失败」的正向形态
    expect(skip!.msg).toContain("bad-json");
    expect(skip!.data?.["module"]).toBe("bad-json"); // 结构化模块名（T8 优先读 data.module）
  });

  it("⑩ 配置 source 路径指向坏 JSON 包 → 同待遇跳过（第二调用点的钉）", async () => {
    const home = mk();
    md(join(home, "mods", "bad-src"));
    writeFileSync(join(home, "mods", "bad-src", "package.json"), "}}broken");
    writeFileSync(join(home, "config.toml"), '[my-mod]\nsource = "./mods/bad-src"\n');
    const { recs, sink: s } = capturingSink();
    const found = await discoverModules({ userDir: join(home, "no"), projectDir: join(home, "no"), userFile: join(home, "config.toml"), sink: s });
    expect(found).toHaveLength(0);
    const skip = recs.find((r) => r.code === "kernel.discover.skip");
    expect(skip).toBeDefined();
    expect(skip!.msg).toContain("包描述读取失败");
    expect(skip!.msg).toContain("my-mod");
    expect(skip!.data?.["module"]).toBe("my-mod");
  });

  it("⑪ 入口存在但读取抛错（目录被 exports 指为入口 → readFileSync EISDIR）→ 跳过不抛，warn 含「入口读取失败」", async () => {
    const user = mk();
    md(join(user, "mods", "dir-entry", "entry")); // entry 是目录：existsSync 过、readFileSync 抛
    writeFileSync(join(user, "mods", "dir-entry", "package.json"), JSON.stringify({ orosus: { module: true }, exports: { "./module": "./entry" } }));
    const { recs, sink: s } = capturingSink();
    const found = await discoverModules({ userDir: join(user, "mods"), projectDir: join(user, "none"), sink: s });
    expect(found).toHaveLength(0);
    const skip = recs.find((r) => r.code === "kernel.discover.skip");
    expect(skip).toBeDefined();
    expect(skip!.msg).toContain("入口读取失败"); // S3 五轮补钉：坏入口文案别与「无模块入口」良性形态混同
    expect(skip!.msg).toContain("dir-entry");
    expect(skip!.data?.["module"]).toBe("dir-entry");
  });
});
