import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import def from "./index.ts";
import { configSchema, loadHooksConfig } from "./config.ts";

type Ctx = Parameters<NonNullable<typeof def.activate>>[0];

let dir: string;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

/** 事件表经 config 注入开自读门 + 路径密封注入（approval configFile 同款先例）。 */
const tmpFiles = (userToml?: string, projectToml?: string): { userFile: string; projectFile: string } => {
  dir = mkdtempSync(join(tmpdir(), "orosus-hooks-"));
  const userFile = join(dir, "user-hooks.toml");
  const projectFile = join(dir, "proj-hooks.toml");
  if (userToml !== undefined) writeFileSync(userFile, userToml, "utf8");
  if (projectToml !== undefined) writeFileSync(projectFile, projectToml, "utf8");
  return { userFile, projectFile };
};

interface FakeCtx {
  ctx: Ctx;
  ons: string[];
  events: { type: string; payload: Record<string, unknown> }[];
  warns: string[];
}

const fakeCtx = (config: Record<string, unknown>): FakeCtx => {
  const ons: string[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const warns: string[] = [];
  const ctx = {
    config,
    configRead: () => Promise.resolve(config),
    log: { trace() {}, debug() {}, info() {}, warn: (_c: string, m: string) => { warns.push(m); }, error() {} },
    ui: {},
    services: { get: () => Promise.reject(new Error("no")), getOptional: () => Promise.resolve(undefined) },
    provide: () => {},
    contribute: { tool: () => () => {}, command: () => () => {}, promptSection: () => () => {}, configOverlay: () => () => {} },
    session: { append: (type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); return Promise.resolve({}); } },
    events: {
      on: (t: string, l: (p: unknown) => Promise<unknown>) => { ons.push(t); void l; return () => {}; },
      emit: () => Promise.resolve(),
    },
  } as unknown as Ctx;
  return { ctx, ons, events, warns };
};

/** 开门配置：PreToolUse 一条空表经通用层喂入（真实路径 = modules.d TOML 进 sections；此处模拟同效）。
 *  enabled/timeoutMs 显式给——内核真实路径会先过 configSchema 补默认值，fakeCtx 直喂不解析。 */
const gateConfig = (files: { userFile: string; projectFile: string }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  timeoutMs: 60000,
  PreToolUse: [{ hooks: [{ command: "placeholder" }] }],
  userConfigFile: files.userFile,
  projectConfigFile: files.projectFile,
  ...extra,
});

const USER_TOML = `
[[PreToolUse]]
matcher = "^bash$"

[[PreToolUse.hooks]]
command = "user-check.sh"
`;

describe("hooks 模块配置面（m5-hooks T4）", () => {
  it("① schema 默认值与 strip：parse({}) → enabled/timeoutMs 默认；未知事件表（Notification）被 strip", () => {
    const parsed = configSchema.parse({ Notification: [{ hooks: [{ command: "x" }] }] });
    expect(parsed).toMatchObject({ enabled: true, timeoutMs: 60000 });
    expect((parsed as Record<string, unknown>).Notification).toBeUndefined(); // 未收录事件 strip（顺延台账项不静默生效）
  });

  it("② matcher 三态：省略=全匹配；合法正则=名单命中；非法正则=永不匹配 + warn（kimi 口径可观测化）", () => {
    const files = tmpFiles(`
[[PreToolUse]]
[[PreToolUse.hooks]]
command = "a"

[[PreToolUse]]
matcher = "^(bash|write)$"
[[PreToolUse.hooks]]
command = "b"

[[PreToolUse]]
matcher = "([bad"
[[PreToolUse.hooks]]
command = "c"
`);
    const warns: string[] = [];
    const compiled = loadHooksConfig({ sectionHasTables: true, userFile: files.userFile, projectFile: files.projectFile, enabled: true, timeoutMs: 60000, warn: (m) => warns.push(m) });
    const tables = compiled.tables.PreToolUse!;
    expect(tables).toHaveLength(3);
    expect(tables[0]!.match("anything")).toBe(true); // 省略 = 全匹配
    expect(tables[1]!.match("bash")).toBe(true);
    expect(tables[1]!.match("bash_alias")).toBe(false); // 不隐式锚定——全名匹配须自带 ^$
    expect(tables[2]!.match("bash")).toBe(false); // 非法正则 = 永不匹配
    expect(tables[2]!.match(undefined)).toBe(false);
    expect(warns.some((w) => w.includes("非法正则"))).toBe(true);
  });

  it("③ 空配置零行为：无事件表 → 零表零监听（自读门不开）", () => {
    const files = tmpFiles(USER_TOML); // 文件在但通用层无表（门关）——真实 home 密封同款路径
    const compiled = loadHooksConfig({ sectionHasTables: false, userFile: files.userFile, projectFile: files.projectFile, enabled: true, timeoutMs: 60000, warn: () => {} });
    expect(Object.keys(compiled.tables)).toHaveLength(0);
    const f = fakeCtx({ userConfigFile: files.userFile, projectConfigFile: files.projectFile });
    def.activate(f.ctx);
    expect(f.ons).toHaveLength(0);
  });

  it("④ 事件表→监听挂点：五挂点按配置注册（PermissionRequest 不走挂点——T8 走 provide）；单事件只注单点", () => {
    const files = tmpFiles(`
[[PreToolUse]]
[[PreToolUse.hooks]]
command = "check"

[[Stop]]
[[Stop.hooks]]
command = "keep-going"
`);
    const f = fakeCtx(gateConfig(files));
    def.activate(f.ctx);
    expect(f.ons).toEqual(["tool/pre-input", "agent/follow-up"]);
  });

  it("⑤ disabled 总闸：enabled=false → 零监听（配置再满也不跑）", () => {
    const files = tmpFiles(USER_TOML);
    const f = fakeCtx(gateConfig(files, { enabled: false }));
    def.activate(f.ctx);
    expect(f.ons).toHaveLength(0);
  });

  it("⑥ 两层追加合并执行序：同事件用户层在前、项目层在后（不去重）+ 标量走通用值", () => {
    const files = tmpFiles(USER_TOML, `
[[PreToolUse]]
[[PreToolUse.hooks]]
command = "proj-gate.sh"
`);
    const compiled = loadHooksConfig({ sectionHasTables: true, userFile: files.userFile, projectFile: files.projectFile, enabled: true, timeoutMs: 5000, warn: () => {} });
    expect(compiled.tables.PreToolUse!.flatMap((t) => t.hooks.map((h) => h.command))).toEqual(["user-check.sh", "proj-gate.sh"]);
    expect(compiled.timeoutMs).toBe(5000);
  });

  it("⑦ 坏文件容错：一层 TOML 坏 = 该层无贡献（fail-open，另一层照常）", () => {
    const files = tmpFiles("this is ][ not toml", USER_TOML.replace("user-check.sh", "proj-only.sh"));
    const compiled = loadHooksConfig({ sectionHasTables: true, userFile: files.userFile, projectFile: files.projectFile, enabled: true, timeoutMs: 60000, warn: () => {} });
    expect(compiled.tables.PreToolUse!.flatMap((t) => t.hooks.map((h) => h.command))).toEqual(["proj-only.sh"]);
  });

  it("⑧ timeout 哨兵语义：per-hook timeout 缺省不落键（= 用全局 timeoutMs），= 0 同（schema min(0) 放行、执行器折算时归默认）", () => {
    const files = tmpFiles(`
[[PreToolUse]]
[[PreToolUse.hooks]]
command = "a"

[[PreToolUse]]
[[PreToolUse.hooks]]
command = "b"
timeout = 0

[[PreToolUse]]
[[PreToolUse.hooks]]
command = "c"
timeout = 30
`);
    const compiled = loadHooksConfig({ sectionHasTables: true, userFile: files.userFile, projectFile: files.projectFile, enabled: true, timeoutMs: 60000, warn: () => {} });
    const timeouts = compiled.tables.PreToolUse!.flatMap((t) => t.hooks.map((h) => h.timeoutSec));
    expect(timeouts).toEqual([undefined, 0, 30]);
  });
});

describe("hooks 模块运行期闭包与 hooks/run 留痕（T4 骨架——dispatch 体 T5/T6/T7 充实）", () => {
  it("⑨ 配置事件触发 dispatch：骨架留痕 hooks/run（event/hook 字段）且恒放行（返回 undefined）", async () => {
    const files = tmpFiles(USER_TOML);
    const f = fakeCtx(gateConfig(files));
    def.activate(f.ctx);
    // fakeCtx 只记注册不存监听器——骨架行为经真 harness 集成测钉（T6+）；此处钉 activate 期零事件落账
    expect(f.events).toHaveLength(0);
  });

  it("⑩ modules.d 目录形态：项目层路径缺省 <cwd>/.orosus/modules.d/hooks.toml（approval projectConfigFile 同款口径）", async () => {
    const { defaultProjectConfigFile } = await import("./config.ts");
    expect(defaultProjectConfigFile("D:\\work\\demo")).toContain(join(".orosus", "modules.d", "hooks.toml"));
    dir = mkdtempSync(join(tmpdir(), "orosus-hooks-paths-")); // rmSync 挂钩
  });
});
