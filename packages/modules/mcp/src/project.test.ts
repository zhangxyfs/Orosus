// T12（m4-3c）：项目 .mcp.json 识别 + 指纹信任门。gate 层纯测（合并优先级/指纹语义/信任往返），
// 读取层走真实临时目录（缺文件/坏 JSON/坏形状三分支）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProjectMcpJson, gateProjectServers, fingerprintServer,
  loadMcpTrust, saveMcpTrust, trustProjectServer, foldProjectPath, mcpTrustFile,
} from "./project.ts";

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
