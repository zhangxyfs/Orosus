import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModuleSubcommand } from "./module-cmd.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orosus-modcmd-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeIo(config = "") {
  const configPath = join(dir, "config.toml");
  if (config !== "") writeFileSync(configPath, config);
  const lines: string[] = [];
  return {
    configPath,
    trustFile: join(dir, "trust.json"),
    discovered: [
      { name: "scanned-mod", root: join(dir, "mods", "scanned-mod"), entryHash: "h1", layer: "project" as const },
      { name: "evil-mod", root: join(dir, "mods", "evil-mod"), entryHash: "h2", layer: "project" as const },
    ],
    out: (l: string) => void lines.push(l),
    lines,
  };
}

describe("CLI module 子命令（§8.6 配置写器）", () => {
  it("① module enable x → section enabled=true（存在则改，不存在则新建仅含 enabled 的 section——目录扫描模块首次启停路径）", async () => {
    const io = makeIo('model = "openai/gpt-4.1"\n\n[tool-fs]\nmaxFileSize = "10MB"\n');
    expect(await runModuleSubcommand(["module", "enable", "scanned-mod"], io)).toBe(0);
    const toml = readFileSync(io.configPath, "utf8");
    expect(toml).toContain("[scanned-mod]");
    expect(toml).toContain("enabled = true");
    expect(toml).toContain("[tool-fs]"); // 既有 section 保留
  });

  it("② module disable x 同理", async () => {
    const io = makeIo("[tool-fs]\nenabled = true\n");
    expect(await runModuleSubcommand(["module", "disable", "tool-fs"], io)).toBe(0);
    expect(readFileSync(io.configPath, "utf8")).toContain("enabled = false");
  });

  it("③ module list → 已发现模块含状态（active/failed/untrusted/discovered）", async () => {
    const io = makeIo();
    expect(await runModuleSubcommand(["module", "list"], io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toContain("scanned-mod");
    expect(out).toContain("untrusted"); // evil-mod 无信任登记
  });

  it("④ module trust x → 写 trust.json（归一化键 + hash）", async () => {
    const io = makeIo();
    expect(await runModuleSubcommand(["module", "trust", "scanned-mod"], io)).toBe(0);
    expect(existsSync(io.trustFile)).toBe(true);
    const stored = JSON.parse(readFileSync(io.trustFile, "utf8")) as { entries: Record<string, { hash: string }> };
    const key = Object.keys(stored.entries)[0]!;
    expect(stored.entries[key]!.hash).toBe("h1");
  });
});
