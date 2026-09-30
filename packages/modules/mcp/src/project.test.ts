// T12（m4-3c）：项目 .mcp.json 识别 + 指纹信任门。gate 层纯测（合并优先级/指纹语义/信任往返），
// 读取层走真实临时目录（缺文件/坏 JSON/坏形状三分支）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProjectMcpJson, gateProjectServers, fingerprintServer,
  loadMcpTrust, saveMcpTrust, trustProjectServer, foldProjectPath, mcpTrustFile,
} from "./project.ts";
import { buildCatalogRows, mcpDef, type McpCatalogRow } from "./index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `orosus-mcp-t12-${tag}-`));
  dirs.push(d);
  return d;
};

describe("T12 项目 .mcp.json 信任门（m4-3c）", () => {
  it("① 读取层：Claude 形状进、缺文件/坏 JSON/根形状不对全空、坏条目丢弃带警告", () => {
    const d = tmp("read");
    expect(readProjectMcpJson(d)).toEqual({ servers: {}, warnings: [] }); // 缺文件
    writeFileSync(join(d, ".mcp.json"), "{ 坏 JSON", "utf8");
    const bad = readProjectMcpJson(d);
    expect(bad.servers).toEqual({});
    expect(bad.warnings[0]).toContain("解析失败");
    writeFileSync(join(d, ".mcp.json"), JSON.stringify({ servers: { x: { command: "y" } } }), "utf8"); // 根不是 mcpServers
    expect(readProjectMcpJson(d).warnings[0]).toContain("形状不对");
    writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: {
      good: { command: "npx", args: ["-y", "pkg"], env: { K: "v" } },
      badArgs: { command: "x", args: "not-array" },
      remote: { url: "https://r/mcp", headers: { authorization: "Bearer t" } },
    } }), "utf8");
    const r = readProjectMcpJson(d);
    expect(Object.keys(r.servers).sort()).toEqual(["good", "remote"]);
    expect(r.servers.good).toEqual({ command: "npx", args: ["-y", "pkg"], env: { K: "v" } });
    expect(r.warnings.some((w) => w.includes("badArgs"))).toBe(true);
  });

  it("② 指纹语义：值不进键名进——换 env/headers 值指纹不变；加键/改命令/改 URL 指纹变；键序无关", () => {
    const base = { command: "npx", args: ["-y", "p"], env: { TOKEN: "aaa" }, headers: { authorization: "Bearer x" } };
    expect(fingerprintServer({ env: { TOKEN: "bbb" }, ...base, headers: { authorization: "Bearer y" } })).toBe(fingerprintServer(base)); // 只换值
    expect(fingerprintServer({ ...base, env: { TOKEN: "aaa", EXTRA: "1" } })).not.toBe(fingerprintServer(base)); // 加 env 键
    expect(fingerprintServer({ ...base, command: "node" })).not.toBe(fingerprintServer(base));
    expect(fingerprintServer({ ...base, args: ["-y", "q"] })).not.toBe(fingerprintServer(base));
    const urlCfg = { url: "https://a/mcp" };
    expect(fingerprintServer({ url: "https://b/mcp" })).not.toBe(fingerprintServer(urlCfg));
    const reordered = { env: { A: "1", B: "2" }, command: "c" };
    expect(fingerprintServer({ command: "c", env: { B: "2", A: "1" } })).toBe(fingerprintServer(reordered)); // 键序无关
  });

  it("③ 门与合并：未确认不连进 pending；登记后放行；指纹变重新待确认；手写同名赢（项目条目整条让位）", () => {
    const d = tmp("gate");
    const trustFile = join(d, "trust.json");
    const projectServers = {
      proj: { command: "node", args: ["s.mjs"] },
      evil: { url: "https://evil/mcp" },
    };
    // 未确认：两件都进 pending、不进 servers
    let gated = gateProjectServers({ userServers: {}, projectServers, trustFile, projectPath: d, platform: "linux" });
    expect(Object.keys(gated.servers)).toEqual([]);
    expect(gated.pending.map((p) => p.name).sort()).toEqual(["evil", "proj"]);
    // 登记一件（拿 pending 里的真指纹）
    const projFp = gated.pending.find((p) => p.name === "proj")!.fingerprint;
    trustProjectServer(trustFile, d, "linux", "proj", projFp);
    gated = gateProjectServers({ userServers: {}, projectServers, trustFile, projectPath: d, platform: "linux" });
    expect(gated.servers.proj).toEqual({ command: "node", args: ["s.mjs"] });
    expect(gated.pending.map((p) => p.name)).toEqual(["evil"]); // 未登记的还在门外
    // 配置被改（指纹变）→ 重新待确认
    const changed = { proj: { command: "node", args: ["other.mjs"] } };
    gated = gateProjectServers({ userServers: {}, projectServers: changed, trustFile, projectPath: d, platform: "linux" });
    expect(gated.pending.map((p) => p.name)).toEqual(["proj"]);
    // 手写同名赢：项目条目整条让位（不连它、不进 pending——「停用覆盖」玩法的基础）
    gated = gateProjectServers({ userServers: { proj: { command: "mine", enabled: false } }, projectServers, trustFile, projectPath: d, platform: "linux" });
    expect(gated.servers.proj).toEqual({ command: "mine", enabled: false });
    expect(gated.pending.map((p) => p.name)).toEqual(["evil"]);
  });

  it("④ 折叠大小写：win32 同路径不同大小写同一把钥匙；linux 不折叠；信任库坏文件=空库重建", () => {
    expect(foldProjectPath("D:\\Proj\\App", "win32")).toBe(foldProjectPath("d:\\proj\\APP", "win32"));
    expect(foldProjectPath("/a/B", "linux")).not.toBe(foldProjectPath("/a/b", "linux"));
    const d = tmp("fold");
    const trustFile = join(d, "trust.json");
    writeFileSync(trustFile, "不是 JSON", "utf8");
    expect(loadMcpTrust(trustFile)).toEqual({ trusted: {} }); // 坏库 = 空
    const cfg = { command: "x" };
    const realFp = gateProjectServers({ userServers: {}, projectServers: { s: cfg }, trustFile, projectPath: "D:\\Proj\\App", platform: "win32" }).pending.find((p) => p.name === "s")!.fingerprint;
    trustProjectServer(trustFile, "D:\\Proj\\App", "win32", "s", realFp);
    const gated = gateProjectServers({
      userServers: {}, projectServers: { s: cfg },
      trustFile, projectPath: "d:\\PROJ\\app", platform: "win32",
    });
    expect(gated.pending).toEqual([]); // 大小写不同但对上同一记录
    expect(gated.servers.s).toEqual({ command: "x" });
  });

  it("⑤ 信任库往返：save → load 保形；mcpTrustFile 落 ~/.orosus/", () => {
    const d = tmp("store");
    const f = join(d, "trust.json");
    saveMcpTrust(f, { trusted: { "/p": { s: "fp" } } });
    expect(existsSync(f)).toBe(true);
    expect(loadMcpTrust(f)).toEqual({ trusted: { "/p": { s: "fp" } } });
    const parsed = JSON.parse(readFileSync(f, "utf8")) as { trusted: Record<string, Record<string, string>> };
    expect(parsed.trusted["/p"]!.s).toBe("fp"); // 落盘是人读 JSON
    expect(mcpTrustFile().replace(/\\/g, "/")).toContain(".orosus/mcp-trust.json");
  });
});

describe("T16 mcp.catalog 数据服务（m4-3c）", () => {
  const base = {
    userServerNames: new Set(["mine"]),
    mergedServers: {
      mine: { command: "node", args: ["m.js"] },
      off: { url: "https://off/mcp", enabled: false },
      down: { command: "bad" },
    },
    projectServers: { proj: { command: "node", args: ["p.mjs"] }, evil: { url: "https://e/mcp" } },
    connected: [{ name: "mine", tools: ["a", "b"], toolLines: ["- a：x", "- b：y"], instructions: "[mcp:mine] 用我" }],
    failed: [{ name: "down", reason: "spawn ENOENT\n[stderr] boom" }],
    pending: [{ name: "evil", fingerprint: "abcd1234abcd1234" }],
  };

  it("① 五档状态归位：connected/idle 缺（activateMcp 不产生）/failed/pending-confirm/disabled 各就各位", () => {
    const rows = buildCatalogRows(base);
    const by = (n: string): McpCatalogRow => rows.find((r) => r.name === n)!;
    expect(by("mine").state).toBe("connected");
    expect(by("mine").toolCount).toBe(2);
    expect(by("mine").tools).toEqual(["a", "b"]);
    expect(by("mine").instructions).toBe("[mcp:mine] 用我");
    expect(by("mine").source).toBe("config");
    expect(by("mine").transport).toBe("stdio");
    expect(by("mine").command).toBe("node m.js");
    expect(by("down").state).toBe("failed");
    expect(by("down").failReason).toContain("[stderr] boom");
    expect(by("evil").state).toBe("pending-confirm");
    expect(by("evil").source).toBe("project");
    expect(by("evil").transport).toBe("http");
    expect(by("evil").url).toBe("https://e/mcp");
    expect(by("evil").fingerprint).toBe("abcd1234abcd1234");
    expect(by("off").state).toBe("disabled");
    expect(by("off").source).toBe("project"); // 项目件被用户覆盖停用——来源仍记项目
  });

  it("② harness 真模块：服务可解析、行快照与实际连接一致（fixture 当 server）", async () => {
    const { createHarness, InMemorySessionStore } = await import("@orosus/core");
    const { fakeProviderModule } = await import("@orosus/testing");
    const { fileURLToPath } = await import("node:url");
    const FIXTURE = fileURLToPath(new URL("../../../../tests/fixtures/mcp-fixture-server.mjs", import.meta.url));
    const dir = tmp("harness");
    const modulesDir = join(dir, "modules.d");
    mkdirSync(modulesDir, { recursive: true });
    writeFileSync(join(modulesDir, "mcp.toml"), `[mcp.servers.fx]
command = "node"
args = ["${FIXTURE.split("\\").join("/")}"]
`, "utf8");
    const h = await createHarness({
      store: new InMemorySessionStore(),
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [mcpDef as never, fakeProviderModule("fake", [])],
      config: { userFile: join(dir, "u.toml"), userModulesDir: modulesDir, projectFile: join(dir, "p.toml"), projectModulesDir: join(dir, "pm"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    try {
      const catalog = await h.graph().services.getOptional("mcp.catalog");
      expect(typeof catalog).toBe("function");
      const rows = (catalog as () => McpCatalogRow[])();
      const fx = rows.find((r) => r.name === "fx");
      expect(fx?.state).toBe("connected");
      expect(fx?.source).toBe("config");
      expect(fx?.toolCount).toBeGreaterThan(5); // fixture 工具面全量
      expect(rows.find((r) => r.state === "pending-confirm")).toBeUndefined(); // cwd 无 .mcp.json
    } finally {
      await h.close();
    }
  }, 30_000);
});
