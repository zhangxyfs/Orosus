// T14（m4-3c）：官方注册表——归一化/缓存纪律/安装决策纯钉 + browse/install 命令分支注入式
// （网络不进测试：fetchImpl 注入假实现；API 形状锚自 2026-09-30 实测）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import {
  normalizeRegistry, readRegistryCache, writeRegistryCache, searchRegistry, decideInstall,
  REGISTRY_TTL_MS, defaultRegistryCacheFile,
} from "./mcp-registry.ts";
import { runMcpCommand, type McpCmdDeps } from "./mcp-cmd.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `orosus-mcpreg-${tag}-`));
  dirs.push(d);
  return d;
};

const RAW = {
  servers: [
    {
      server: {
        name: "io.github/github-mcp-server",
        description: "GitHub 官方 server\n第二行不该出现",
        version: "1.0.0",
        repository: { url: "https://github.com/github/github-mcp-server", source: "github" },
        installations: [{ type: "stdio", command: "npx", args: ["-y", "@github/github-mcp-server"], env: [{ name: "GITHUB_TOKEN", isRequired: true }, { name: "OPT", isRequired: false }] }],
      },
    },
    {
      server: {
        name: "ai.smithery/mini",
        description: "干净的远程 server",
        version: "0.2.0",
        remotes: [{ type: "streamable-http", url: "https://mini.example/mcp", headers: [{ name: "Authorization", isRequired: true }] }],
      },
    },
    {
      server: {
        name: "io.clean/plain",
        description: "无密钥本地 server",
        version: "3.1.4",
        installations: [{ type: "stdio", command: "npx", args: ["-y", "plain"], env: [] }],
      },
    },
    { server: { description: "没名字的坏条目" } },
  ],
};

describe("T14 注册表归一化与决策（纯钉）", () => {
  it("① normalizeRegistry：三好条目各就各位（stdio/remote/短名/必填项）、坏条目丢弃", () => {
    const entries = normalizeRegistry(RAW);
    expect(entries).toHaveLength(3);
    const gh = entries.find((e) => e.shortName === "github-mcp-server")!;
    expect(gh.name).toBe("io.github/github-mcp-server");
    expect(gh.repositoryUrl).toContain("github.com/github");
    expect(gh.stdio).toEqual({ command: "npx", args: ["-y", "@github/github-mcp-server"], requiredEnv: ["GITHUB_TOKEN"] });
    const mini = entries.find((e) => e.shortName === "mini")!;
    expect(mini.remote).toEqual({ url: "https://mini.example/mcp", requiredHeaders: ["Authorization"] });
    const plain = entries.find((e) => e.shortName === "plain")!;
    expect(plain.stdio?.requiredEnv).toEqual([]);
  });

  it("② decideInstall：干净 stdio 直装；必填 env/headers 拒绝半自动给手填模板；未命中/歧义", () => {
    const entries = normalizeRegistry(RAW);
    const clean = decideInstall(entries, "plain");
    expect(clean.kind).toBe("stdio");
    if (clean.kind === "stdio") expect(clean.values).toEqual({ command: "npx", args: ["-y", "plain"] });
    const gh = decideInstall(entries, "github-mcp-server"); // 全名与短名同达
    expect(gh.kind).toBe("needs-secrets");
    if (gh.kind === "needs-secrets") {
      expect(gh.missing).toEqual(["GITHUB_TOKEN"]);
      expect(gh.template).toContain('[mcp.servers.github-mcp-server]');
      expect(gh.template).toContain('GITHUB_TOKEN = "$ENV:GITHUB_TOKEN"');
    }
    const mini = decideInstall(entries, "mini");
    expect(mini.kind).toBe("needs-secrets");
    if (mini.kind === "needs-secrets") expect(mini.template).toContain('[mcp.servers.mini.headers]');
    expect(decideInstall(entries, "ghost").kind).toBe("not-found");
  });

  it("③ 缓存信封往返 + TTL 常量钉 30 天 + 默认落点", () => {
    expect(REGISTRY_TTL_MS).toBe(30 * 24 * 3600 * 1000);
    const d = tmp("cache");
    const f = join(d, "mcp-registry.json");
    expect(readRegistryCache(f)).toBeUndefined(); // 缺文件
    writeFileSync(f, "坏 JSON", "utf8");
    expect(readRegistryCache(f)).toBeUndefined(); // 坏文件 = 无缓存
    writeRegistryCache(f, { fetchedAt: "2026-09-30T00:00:00Z", entries: [{ name: "a/b", shortName: "b", description: "", version: "" }] });
    const got = readRegistryCache(f);
    expect(got?.entries[0]!.shortName).toBe("b");
    expect(defaultRegistryCacheFile("C:/x/.orosus/cache").replace(/\\/g, "/")).toBe("C:/x/.orosus/cache/mcp-registry.json");
  });

  it("④ searchRegistry 纪律：新鲜缓存零网络；过期先网；断网回落过期缓存；无缓存断网两手空空", async () => {
    const d = tmp("search");
    const f = join(d, "mcp-registry.json");
    writeRegistryCache(f, { fetchedAt: new Date().toISOString(), entries: normalizeRegistry(RAW) });
    let calls = 0;
    const fakeFetch = (async () => { calls += 1; return { ok: true, json: async () => RAW } as unknown as Response; }) as typeof fetch;
    const fresh = await searchRegistry({ query: "plain", cacheFile: f, fetchImpl: fakeFetch });
    expect(fresh.fetched).toBe(false); // 新鲜缓存——零网络
    expect(calls).toBe(0);
    expect(fresh.entries[0]!.shortName).toBe("plain");

    writeRegistryCache(f, { fetchedAt: new Date(Date.now() - REGISTRY_TTL_MS - 1000).toISOString(), entries: [] });
    const refetched = await searchRegistry({ query: "plain", cacheFile: f, fetchImpl: fakeFetch });
    expect(refetched.fetched).toBe(true); // 过期——先试网
    expect(refetched.entries[0]!.shortName).toBe("plain");
    expect(readRegistryCache(f)!.entries).toHaveLength(3); // 拉到即落盘

    // 步骤2把缓存刷成新鲜了——断网回落要验「过期缓存 + 网络失败」，先重新写老
    writeRegistryCache(f, { fetchedAt: new Date(Date.now() - REGISTRY_TTL_MS - 1000).toISOString(), entries: normalizeRegistry(RAW) });
    const failing = (async () => { throw new Error("离线"); }) as typeof fetch;
    const offline = await searchRegistry({ query: "plain", cacheFile: f, fetchImpl: failing });
    expect(offline.offline).toBe(true);
    expect(offline.fetched).toBe(false);

    const empty = await searchRegistry({ query: "x", cacheFile: join(d, "无.json"), fetchImpl: failing });
    expect(empty).toEqual({ entries: [], fetched: false, offline: true });
  });
});

describe("T14 browse/install 命令分支（注入式）", () => {
  const deps = (d: string): McpCmdDeps => ({
    configPath: () => join(d, "modules.d", "mcp.toml"),
    projectPath: () => d,
    trustFile: () => join(d, "trust.json"),
    platform: "linux",
    registryCachePath: () => join(d, "mcp-registry.json"),
    fetchImpl: (async () => ({ ok: true, json: async () => RAW } as unknown as Response)) as typeof fetch,
  });

  it("① browse：列出命中（形态标签 + 需配置项 + 描述首行截断）、断网无缓存给人话、空关键词给用法", async () => {
    const d = tmp("browse");
    const r = await runMcpCommand("browse github", deps(d));
    expect(r.wrote).toBe(false);
    expect(r.text).toContain("`io.github/github-mcp-server` 本地（需配置：GITHUB_TOKEN）");
    expect(r.text).toContain("GitHub 官方 server"); // 描述首行
    expect(r.text).not.toContain("第二行");
    expect(r.text).toContain("/mcp install 名字");
    const usage = await runMcpCommand("browse", deps(d));
    expect(usage.text).toContain("用法");
    const offlineDeps = { ...deps(tmp("browse-off")), fetchImpl: (async () => { throw new Error("离线"); }) as typeof fetch };
    const offline = await runMcpCommand("browse x", offlineDeps);
    expect(offline.text).toContain("网络不可用");
  });

  it("② install：干净条目写盘 + wrote=true；需密钥拒绝半自动给模板；未命中给指路；重名不覆盖", async () => {
    const d = tmp("install");
    const dp = deps(d);
    const clean = await runMcpCommand("install plain", dp);
    expect(clean.wrote).toBe(true);
    const doc = parse(readFileSync(dp.configPath(), "utf8")) as { mcp: { servers: Record<string, unknown> } };
    expect(doc.mcp.servers.plain).toEqual({ command: "npx", args: ["-y", "plain"] });
    const gh = await runMcpCommand("install github-mcp-server", dp);
    expect(gh.wrote).toBe(false);
    expect(gh.text).toContain("需要密钥");
    expect(gh.text).toContain("$ENV:");
    const nf = await runMcpCommand("install ghost", dp);
    expect(nf.text).toContain("没找到");
    const dup = await runMcpCommand("install io.clean/plain", dp); // 全名同达——重名拒绝
    expect(dup.wrote).toBe(false);
    expect(dup.text).toContain("不覆盖");
  });

  it("③ 断网 + 缓存在场：install 走缓存照样装（设计空白：断网用缓存）", async () => {
    const d = tmp("install-off");
    const dp = deps(d);
    await runMcpCommand("browse warm", dp); // 预热缓存
    const offline = { ...deps(d), fetchImpl: (async () => { throw new Error("离线"); }) as typeof fetch };
    const r = await runMcpCommand("install plain", offline);
    expect(r.wrote).toBe(true);
    expect(parse(readFileSync(dp.configPath(), "utf8")).mcp.servers.plain).toBeDefined();
  });
});
