/** web 批 T13 伴生测试：设置·技能/钩子/记忆/提供商 API——brief ①-⑥ 逐条 + ⑦ providers upsert/remove
 *  写形钉（全真栈 runWebSubcommand + handover 托管，settings-data.test 同款）：
 *  - ① GET /api/settings/skills：四轨 scope/file 字段（user/project 轨种子 + bundled 轨随包）；POST
 *    toggle 写 modules.d/skill.toml disabled 数组 + reload + 再 GET 回读 + 回翻删键；
 *  - ② GET /api/settings/hooks：两层分节（user/project 各一钩）+ projectTrusted:false；POST toggle 行级
 *    改写（disabled = true 落到目标 [[hooks.<Event>.hooks]] 行）；POST trust 写 <home>/hooks/hooks-trust.json
 *    （digest 登记）+ GET projectTrusted 翻 true；file 白名单外的写 → 400；
 *  - ③ GET/POST /api/settings/memory：双开关写 modules.d/tool-peers.toml [tool-peers] 键 + 读回 +
 *    坏 key 400；sources = 五源探测（密封 HOME——无源空表）；
 *  - ④ POST /api/settings/memory/import：无源 → {ok, imported:0}；种 ~/.codex/memories 一条 →
 *    imported:1 且落当前项目记忆桶；
 *  - ⑤ POST /api/providers/cmd：透传 ['provider','list'] → {code:0, out 非空含本地槽名}（getCatalog
 *    注入——零真网络）；未知子命令 → code:1 用法文案；argv[0] 非 provider → 400；
 *  - ⑥ GET /api/providers/catalog：读盘上缓存（<home>/cache/models-dev.json 信封）——vendors 结构
 *    （key/name/proto/baseUrl + models[{id,ctx,label}] 真目录值）+ source:"cache"；缺缓存 → 空表；
 *  - ⑦ POST /api/providers upsert/remove：槽内键序 type/baseUrl/apiKey?/defaultModel?（provider-cmd
 *    写形同款）+ apiKey 槽内只写 $ENV: 引用（值经 upsertSecret 落 secrets.env）+ contextWindow 顶层键
 *    （数字裸）+ 编辑不重发 apiKey 时保留旧引用 + remove 删节键 + removeSecret 连删 secret 行；校验族
 *    （坏 slot/未知 spec 键/坏 URL/ctx<1024/带换行 apiKey）→ 400 不落盘。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
import { runWebSubcommand } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { setProviderCmdCatalogForTest } from "./api-providers.ts";

/** 轮询等待（25ms 步进；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 引导门放行形态 config.toml（settings-data.test 同款——本文件不发 prompt，死端口即可）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(
    join(home, "config.toml"),
    `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\ntype = "openai"\n`,
    "utf8",
  );
};

/** 种子会话（真盘 jsonl——resume 托管面）。 */
const seedSession = async (home: string, cwd: string, sid: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await store.append("session/label", { label: "设置杂项面" });
  await store.close();
};

interface Stack {
  base: string;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（settings-data.test 同款）。 */
const startWebAt = async (home: string, cwd: string, sid: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    auth: { "x-orosus-token": inst.token, connection: "close" },
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

const getJson = async (s: Stack, path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${s.base}${path}`, { headers: s.auth });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const post = (s: Stack, path: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** 种一轨技能（SKILL.md frontmatter——parseFrontmatter 同源形态）。 */
const seedSkill = (dir: string, name: string, whenToUse?: string): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${name} 的测试描述`,
    ...(whenToUse !== undefined ? [`when_to_use: ${whenToUse}`] : []),
    "---",
    "",
    `# ${name}`,
    "",
    "测试技能正文。",
    "",
  ].join("\n"), "utf8");
};

describe("web T13：设置·技能/钩子/记忆/提供商 API", () => {
  const homes: string[] = [];
  const userHomes: string[] = [];
  const cwds: string[] = [];
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let prevOrosusHome: string | undefined;
  let prevCwd: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t13-"));
    homes.push(h);
    return h;
  };
  /** 密封用户主目录（detectSources 五源/技能 ~/.agents 轨的 homedir 读点——main.test 同款双覆盖）。 */
  const tmpUserHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t13-user-"));
    userHomes.push(h);
    process.env["HOME"] = h;
    process.env["USERPROFILE"] = h;
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t13-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["HOME"];
    prevUserProfile = process.env["USERPROFILE"];
    prevOrosusHome = process.env["OROSUS_HOME"];
    prevCwd = process.cwd();
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退
    setProviderCmdCatalogForTest(undefined); // ⑤ 注入复位
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    if (prevUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = prevUserProfile;
    if (prevOrosusHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevOrosusHome;
    if (prevCwd !== undefined && process.cwd() !== prevCwd) process.chdir(prevCwd); // chdir 兜底复位
    for (const c of cwds.splice(0)) {
      try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
    }
    for (const h of [...userHomes.splice(0), ...homes.splice(0)]) {
      try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  });

  it("① GET /api/settings/skills：四轨 scope/file + usage；POST toggle 写 disabled 数组 + reload + 回翻删键", async () => {
    tmpUserHome();
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    seedSkill(join(home, "skills"), "t13-user-skill", "用户轨测试场景");
    seedSkill(join(cwd, ".orosus", "skills"), "t13-proj-skill"); // git 根缺省回退 cwd——项目 orosus 轨
    await seedSession(home, cwd, "s_skl1");
    const s = await startWebAt(home, cwd, "s_skl1");

    const { status, body } = await getJson(s, "/api/settings/skills");
    expect(status).toBe(200);
    expect(body["ok"]).toBe(true);
    const skills = body["skills"] as { name: string; desc: string; usage?: string; scope: string; file: string; disabled: boolean }[];
    const byName = new Map(skills.map((r) => [r.name, r]));
    const user = byName.get("t13-user-skill");
    expect(user).toBeDefined();
    expect(user!.scope).toBe("user");
    expect(user!.file).toContain(join("t13-user-skill", "SKILL.md"));
    expect(user!.usage).toBe("用户轨测试场景"); // when_to_use → usage?（§3 :249）
    expect(user!.disabled).toBe(false);
    const proj = byName.get("t13-proj-skill");
    expect(proj!.scope).toBe("project");
    expect(proj!.file).toContain(join("t13-proj-skill", "SKILL.md"));
    expect(skills.some((r) => r.scope === "bundled")).toBe(true); // bundled 轨随包在场
    expect(skills.every((r) => typeof r.file === "string" && r.file !== "")).toBe(true);

    // toggle → 写 modules.d/skill.toml disabled 数组 + reload 收口
    const off = await post(s, "/api/settings/skills/toggle", { name: "t13-user-skill", disabled: true });
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as { ok: boolean; report?: { failed: unknown[] } };
    expect(offBody.ok).toBe(true);
    expect(offBody.report?.failed).toEqual([]); // reload 真跑
    const skillToml = readFileSync(join(home, "modules.d", "skill.toml"), "utf8");
    expect(skillToml).toContain("[skill]");
    expect(skillToml).toContain('disabled = ["t13-user-skill"]');
    const g1 = await getJson(s, "/api/settings/skills");
    expect((g1.body["skills"] as { name: string; disabled: boolean }[]).find((r) => r.name === "t13-user-skill")!.disabled).toBe(true);

    // 回翻 → 删键回缺省态（空表 = 删键——toggleSkillDisabled 同款）
    const on = await post(s, "/api/settings/skills/toggle", { name: "t13-user-skill", disabled: false });
    expect(on.status).toBe(200);
    expect(readFileSync(join(home, "modules.d", "skill.toml"), "utf8")).not.toContain("t13-user-skill");
    const g2 = await getJson(s, "/api/settings/skills");
    expect((g2.body["skills"] as { name: string; disabled: boolean }[]).find((r) => r.name === "t13-user-skill")!.disabled).toBe(false);

    // 同态重复 toggle → noop 不写盘；空名 → 400
    const before = readFileSync(join(home, "modules.d", "skill.toml"), "utf8");
    const noop = await post(s, "/api/settings/skills/toggle", { name: "t13-user-skill", disabled: false });
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as { noop?: boolean }).noop).toBe(true);
    expect(readFileSync(join(home, "modules.d", "skill.toml"), "utf8")).toBe(before);
    expect((await post(s, "/api/settings/skills/toggle", { name: "", disabled: true })).status).toBe(400);

    await s.stop();
  }, 60_000);

  it("② GET /api/settings/hooks：两层分节 + trust 态；POST toggle 行级改写 + trust 写 hooks-trust.json；file 白名单外 400", async () => {
    tmpUserHome();
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    const userHooks = join(home, "modules.d", "hooks.toml");
    mkdirSync(join(home, "modules.d"), { recursive: true });
    writeFileSync(userHooks, [
      "[[hooks.SessionStart]]",
      "",
      "[[hooks.SessionStart.hooks]]",
      'command = "echo user-hook"',
      'name = "用户钩子"',
      "",
    ].join("\n"), "utf8");
    const projHooks = join(cwd, ".orosus", "modules.d", "hooks.toml");
    mkdirSync(join(cwd, ".orosus", "modules.d"), { recursive: true });
    writeFileSync(projHooks, [
      "[[hooks.Stop]]",
      "",
      "[[hooks.Stop.hooks]]",
      'command = "echo proj-hook"',
      "",
    ].join("\n"), "utf8");
    await seedSession(home, cwd, "s_hok2");
    const s = await startWebAt(home, cwd, "s_hok2");

    const { status, body } = await getJson(s, "/api/settings/hooks");
    expect(status).toBe(200);
    expect(body["ok"]).toBe(true);
    const user = body["user"] as { event: string; command: string; disabled: boolean; file: string }[];
    const project = body["project"] as { event: string; command: string; disabled: boolean }[];
    expect(user).toHaveLength(1);
    expect(user[0]!.event).toBe("SessionStart");
    expect(user[0]!.command).toBe("echo user-hook");
    expect(user[0]!.file).toBe(userHooks);
    expect(project).toHaveLength(1);
    expect(project[0]!.event).toBe("Stop");
    expect(body["projectTrusted"]).toBe(false); // 未审查

    // toggle：行级改写目标 [[hooks.SessionStart.hooks]]（用户层）
    const off = await post(s, "/api/settings/hooks/toggle", { file: userHooks, event: "SessionStart", tableIdx: 0, hookIdx: 0, disabled: true });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { ok: boolean }).ok).toBe(true);
    const written = readFileSync(userHooks, "utf8");
    expect(written).toContain("disabled = true");
    expect(written).toContain('command = "echo user-hook"'); // 行级改写不洗其余键
    const g1 = await getJson(s, "/api/settings/hooks");
    expect((g1.body["user"] as { disabled: boolean }[])[0]!.disabled).toBe(true);

    // 回翻 → 删行
    const on = await post(s, "/api/settings/hooks/toggle", { file: userHooks, event: "SessionStart", tableIdx: 0, hookIdx: 0, disabled: false });
    expect(on.status).toBe(200);
    expect(readFileSync(userHooks, "utf8")).not.toContain("disabled");

    // trust：写 <home>/hooks/hooks-trust.json（digest 登记当前项目层内容）+ GET 翻 true
    const trust = await post(s, "/api/settings/hooks/trust", {});
    expect(trust.status).toBe(200);
    const trustFile = join(home, "hooks", "hooks-trust.json");
    expect(existsSync(trustFile)).toBe(true);
    const table = JSON.parse(readFileSync(trustFile, "utf8")) as Record<string, { digest: string; trustedAt: string }>;
    expect(Object.keys(table)).toHaveLength(1);
    expect(Object.values(table)[0]!.digest).toMatch(/^[0-9a-f]{64}$/); // sha256
    const g2 = await getJson(s, "/api/settings/hooks");
    expect(g2.body["projectTrusted"]).toBe(true);

    // file 白名单（任意路径写盘防线）：hooksFace 两文件之外 → 400 且不触碰
    const evil = join(home, "evil.toml");
    const bad = await post(s, "/api/settings/hooks/toggle", { file: evil, event: "SessionStart", tableIdx: 0, hookIdx: 0, disabled: true });
    expect(bad.status).toBe(400);
    expect(existsSync(evil)).toBe(false);
    expect((await post(s, "/api/settings/hooks/toggle", { file: userHooks, event: "NotAnEvent", tableIdx: 0, hookIdx: 0, disabled: true })).status).toBe(400);

    await s.stop();
  }, 60_000);

  it("③ GET/POST /api/settings/memory：双开关写 [tool-peers] 键 + 读回；坏 key 400；sources 五源探测（密封 HOME）", async () => {
    const userHome = tmpUserHome();
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_mem3");
    const s = await startWebAt(home, cwd, "s_mem3");

    const g0 = await getJson(s, "/api/settings/memory");
    expect(g0.status).toBe(200);
    expect(g0.body["workspaceMemory"]).toBe(false); // 缺键 = 关
    expect(g0.body["sessionPeers"]).toBe(false);
    expect(g0.body["sources"]).toEqual([]); // 密封 HOME——五源全无货

    const r1 = await post(s, "/api/settings/memory", { key: "workspaceMemory", value: true });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { ok: boolean; report?: { failed: unknown[] } }).report?.failed).toEqual([]); // reload 收口
    const r2 = await post(s, "/api/settings/memory", { key: "sessionPeers", value: true });
    expect(r2.status).toBe(200);
    const peers = readFileSync(join(home, "modules.d", "tool-peers.toml"), "utf8");
    expect(peers).toContain("[tool-peers]");
    expect(peers).toContain("workspaceMemory = true");
    expect(peers).toContain("sessionPeers = true");
    const g1 = await getJson(s, "/api/settings/memory");
    expect(g1.body["workspaceMemory"]).toBe(true);
    expect(g1.body["sessionPeers"]).toBe(true);

    // 坏 key / 坏值 → 400 不写盘
    const before = readFileSync(join(home, "modules.d", "tool-peers.toml"), "utf8");
    expect((await post(s, "/api/settings/memory", { key: "bogus", value: true })).status).toBe(400);
    expect((await post(s, "/api/settings/memory", { key: "workspaceMemory", value: "yes" })).status).toBe(400);
    expect(readFileSync(join(home, "modules.d", "tool-peers.toml"), "utf8")).toBe(before);
    expect(userHome).toBeDefined(); //（密封 HOME 生效性由 ④ 正路径复证）

    await s.stop();
  }, 60_000);

  it("④ POST /api/settings/memory/import：无源 → {imported:0}；种 codex 源一条 → imported:1 落当前项目桶", async () => {
    const userHome = tmpUserHome();
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_imp4");
    const s = await startWebAt(home, cwd, "s_imp4");

    // 无源（密封 HOME、五源目录皆缺）→ imported:0
    const empty = await post(s, "/api/settings/memory/import", {});
    expect(empty.status).toBe(200);
    expect((await empty.json())).toEqual({ ok: true, imported: 0 });
    expect(existsSync(join(home, "memories"))).toBe(false); // 零源零落盘

    // 种 codex 全局源一条（<HOME>/.codex/memories——detectSources codex 轨）
    mkdirSync(join(userHome, ".codex", "memories"), { recursive: true });
    writeFileSync(join(userHome, ".codex", "memories", "t13-note.md"), [
      "---",
      "name: T13 测试记忆",
      "description: 导入链实证条目",
      "---",
      "",
      "# T13 测试记忆",
      "",
      "正文一行。",
      "",
    ].join("\n"), "utf8");
    const g = await getJson(s, "/api/settings/memory");
    expect(g.body["sources"]).toEqual(["codex"]);

    const r = await post(s, "/api/settings/memory/import", {});
    expect(r.status).toBe(200);
    expect((await r.json())).toEqual({ ok: true, imported: 1 });
    // 落当前项目记忆桶（memoryBucketKey 键目录下的 memory/ 有一个 .md）
    const bucketBase = join(home, "memories", "projects");
    const buckets = readdirSync(bucketBase);
    expect(buckets).toHaveLength(1);
    const memDir = join(bucketBase, buckets[0]!, "memory");
    expect(readdirSync(memDir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md")).toHaveLength(1); // MEMORY.md = 索引（countNotes 同口径跳过）

    // 重复导入 → 标题去重 skipped（imported:0——一次性搬运 D18 同款）
    const again = await post(s, "/api/settings/memory/import", {});
    expect(((await again.json()) as { imported: number }).imported).toBe(0);

    await s.stop();
  }, 60_000);

  it("⑤ POST /api/providers/cmd：透传 ['provider','list'] → code:0 out 非空；未知子命令 code:1；非 provider argv 400", async () => {
    tmpUserHome();
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_pcmd5");
    const s = await startWebAt(home, cwd, "s_pcmd5");

    // getCatalog 注入（零真网络——provider-cmd.test 同款口径；生产走模块自带供给链）
    setProviderCmdCatalogForTest(async () => ({
      catalog: { "t13-vendor": { name: "T13 厂商", type: "openai", api: "https://api.t13.dev/v1", models: {} } },
      source: "disk" as const,
    }));

    const r = await post(s, "/api/providers/cmd", { argv: ["provider", "list"] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { code: number; out: string };
    expect(body.code).toBe(0);
    expect(body.out).toContain("demo"); // 本地槽（config [provider-custom.providers.demo]）
    expect(body.out).toContain("t13-vendor"); // 目录槽（注入目录）

    // 未知子命令 → code:1 + 用法文案（runProviderSubcommand 自带校验透传）
    const bad = await post(s, "/api/providers/cmd", { argv: ["provider", "bogus"] });
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as { code: number; out: string };
    expect(badBody.code).toBe(1);
    expect(badBody.out).not.toBe("");

    // 透传面闸：argv[0] 非 provider / 非串数组 → 400（防通用命令执行口）
    expect((await post(s, "/api/providers/cmd", { argv: ["skills", "list"] })).status).toBe(400);
    expect((await post(s, "/api/providers/cmd", { argv: [1, 2] })).status).toBe(400);
    expect((await post(s, "/api/providers/cmd", { argv: ["provider"] })).status).toBe(400);

    await s.stop();
  }, 60_000);

  it("⑥ GET /api/providers/catalog：读盘上缓存结构（vendors/models 真目录值 + source:cache）；缺缓存空表", async () => {
    tmpUserHome();
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_cat6");
    const s = await startWebAt(home, cwd, "s_cat6");

    // 缓存缺省 → 空表（刷新走 POST /api/providers/cmd import 自带路径——红线修正段）
    const empty = await getJson(s, "/api/providers/catalog");
    expect(empty.status).toBe(200);
    expect(empty.body["vendors"]).toEqual([]);
    expect(empty.body["source"]).toBe("cache");

    // 种盘上信封（provider-custom writeDiskCache 同格式：{ fetchedAt, catalog }）
    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(join(home, "cache", "models-dev.json"), JSON.stringify({
      fetchedAt: Date.now(),
      catalog: {
        "t13-vendor": {
          name: "T13 厂商",
          type: "openai",
          api: "https://api.t13.dev/v1",
          models: {
            "t13-max": { id: "t13-max", name: "T13 Max", limit: { context: 256000 } },
            "t13-lite": { id: "t13-lite", limit: { context: 32000 } },
          },
        },
      },
    }), "utf8");

    const { status, body } = await getJson(s, "/api/providers/catalog");
    expect(status).toBe(200);
    expect(body["source"]).toBe("cache");
    const vendors = body["vendors"] as { key: string; name: string; proto: string; baseUrl: string; models: { id: string; label: string; ctx: number }[] }[];
    expect(vendors.map((v) => v.key)).toEqual(["t13-vendor"]);
    const v = vendors[0]!;
    expect(v.name).toBe("T13 厂商");
    expect(v.proto).toBe("openai");
    expect(v.baseUrl).toBe("https://api.t13.dev/v1");
    const byId = new Map(v.models.map((m) => [m.id, m]));
    expect(byId.get("t13-max")!.label).toBe("T13 Max"); // label = 目录 name（真值——/api/models 弱字段的交付面）
    expect(byId.get("t13-max")!.ctx).toBe(256000);
    expect(byId.get("t13-lite")!.label).toBe("t13-lite"); // 无 name 回退 id
    expect(byId.get("t13-lite")!.ctx).toBe(32000);

    await s.stop();
  }, 60_000);

  it("⑦ POST /api/providers upsert/remove：键序/$ENV: 引用/顶层 contextWindow + remove 连删 secret；校验族 400", async () => {
    tmpUserHome();
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    process.chdir(cwd);
    writeProviderConfig(home);
    await seedSession(home, cwd, "s_prov7");
    const s = await startWebAt(home, cwd, "s_prov7");
    const configPath = join(home, "config.toml");
    const secretsPath = join(home, "secrets.env");

    // upsert：apiKey 值落 secrets.env、槽内只写 $ENV: 引用；contextWindow 顶层键（数字裸）
    const up = await post(s, "/api/providers", { op: "upsert", slot: "acme", spec: { type: "openai", baseUrl: "https://api.acme.dev/v1", apiKey: "sk-t13-123", defaultModel: "acme-1", contextWindow: 128000 } });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { ok: boolean; report?: { failed: unknown[] } }).report?.failed).toEqual([]); // reload 收口
    const toml = readFileSync(configPath, "utf8");
    const secStart = toml.indexOf("[provider-custom.providers.acme]");
    expect(secStart).toBeGreaterThanOrEqual(0);
    const secEnd = toml.indexOf("[", secStart + 1) === -1 ? toml.length : toml.indexOf("[", secStart + 1);
    const section = toml.slice(secStart, secEnd);
    // 槽内键序 type → baseUrl → apiKey → defaultModel（provider-cmd.ts:251-255 写形同款）
    const keys = [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]!);
    expect(keys).toEqual(["type", "baseUrl", "apiKey", "defaultModel"]);
    expect(section).toContain('type = "openai"');
    expect(section).toContain('baseUrl = "https://api.acme.dev/v1"');
    expect(section).toContain('apiKey = "$ENV:OROSUS_ACME_KEY"'); // 槽内只写引用
    expect(section).toContain('defaultModel = "acme-1"');
    const secrets = readFileSync(secretsPath, "utf8");
    expect(secrets).toContain("OROSUS_ACME_KEY=sk-t13-123"); // 明文只在 secrets.env
    expect(toml).toContain("contextWindow = 128000"); // 顶层键、数字裸（不带引号）
    expect(toml.indexOf("contextWindow")).toBeLessThan(toml.indexOf("[provider-custom")); // 顶层键在首节头前

    // GET /api/providers 读面：acme 行（proto/baseUrl/defaultModel/modelCount——死端口 live 兜底空表）
    const g = await getJson(s, "/api/providers");
    expect(g.status).toBe(200);
    const rows = (g.body["providers"] as { key: string; proto: string; baseUrl: string; defaultModel?: string; modelCount: number; models: string[] }[])
      .filter((r) => r.key === "acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proto).toBe("openai");
    expect(rows[0]!.baseUrl).toBe("https://api.acme.dev/v1");
    expect(rows[0]!.defaultModel).toBe("acme-1");
    expect(rows[0]!.modelCount).toBe(rows[0]!.models.length);

    // 编辑不重发 apiKey → 保留旧 $ENV: 引用（掩码表单语义）；secret 行不动
    const edit = await post(s, "/api/providers", { op: "upsert", slot: "acme", spec: { type: "openai", baseUrl: "https://api.acme.dev/v2", defaultModel: "acme-2" } });
    expect(edit.status).toBe(200);
    const toml2 = readFileSync(configPath, "utf8");
    expect(toml2).toContain('baseUrl = "https://api.acme.dev/v2"');
    expect(toml2).toContain('defaultModel = "acme-2"');
    expect(toml2).toContain('apiKey = "$ENV:OROSUS_ACME_KEY"');
    expect(readFileSync(secretsPath, "utf8")).toContain("OROSUS_ACME_KEY=sk-t13-123");

    // remove + removeSecret：节键消失 + secret 行连删
    const rm = await post(s, "/api/providers", { op: "remove", slot: "acme", removeSecret: true });
    expect(rm.status).toBe(200);
    expect(readFileSync(configPath, "utf8")).not.toContain("[provider-custom.providers.acme]");
    expect(readFileSync(secretsPath, "utf8")).not.toContain("OROSUS_ACME_KEY");
    // 未知槽 remove → 404
    expect((await post(s, "/api/providers", { op: "remove", slot: "no-such" })).status).toBe(404);

    // 校验族（T11 checkEditSpec 同款纪律——写盘前拒绝，文件字节不变）
    const before = readFileSync(configPath, "utf8");
    const specs: Record<string, unknown>[] = [
      { op: "upsert", slot: "a b", spec: { type: "openai", baseUrl: "https://x.dev" } },        // slot 非 bare-key
      { op: "upsert", slot: "ok1", spec: { type: "openai", baseUrl: "not-a-url" } },           // 坏 URL
      { op: "upsert", slot: "ok2", spec: { type: "openai", baseUrl: "https://x.dev", bogus: 1 } }, // 未知 spec 键
      { op: "upsert", slot: "ok3", spec: { baseUrl: "https://x.dev" } },                        // 缺 type
      { op: "upsert", slot: "ok4", spec: { type: "openai", baseUrl: "https://x.dev", contextWindow: 100 } }, // <1024
      { op: "upsert", slot: "ok5", spec: { type: "openai", baseUrl: "https://x.dev", apiKey: "k\nd" } },     // 换行注入
      { op: "bogus", slot: "x" },                                                               // 未知 op
    ];
    for (const spec of specs) {
      expect((await post(s, "/api/providers", spec)).status).toBe(400);
    }
    expect(readFileSync(configPath, "utf8")).toBe(before); // 全族零落盘
    expect(existsSync(secretsPath)).toBe(true); // 前面 remove 后仅剩文件骨架（或空）——校验族不再触碰

    await s.stop();
  }, 60_000);
});
