import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProviderSubcommand } from "./provider-cmd.ts";
import type { Catalog } from "@orosus/provider-custom";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orosus-provcmd-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CATALOG: Catalog = {
  openrouter: { name: "OpenRouter", type: "openai", api: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"] },
  "no-endpoint-vendor": { name: "NoEndpoint", type: "openai" },
};

function makeIo(env: Record<string, string> = {}, configExists = false) {
  const configPath = join(dir, "config.toml");
  if (configExists) writeFileSync(configPath, 'model = "openai/gpt-4.1"\n');
  const lines: string[] = [];
  return {
    configPath,
    secretsPath: join(dir, "secrets.env"),
    env,
    getCatalog: async () => CATALOG,
    fetchImpl: (async () => new Response("[]", { status: 200 })) as typeof fetch,
    out: (l: string) => void lines.push(l),
    lines,
  };
}

describe("CLI provider 子命令（D34/D37 配置写器）", () => {
  it("import openrouter → 追加 providers 表，apiKey 落 $ENV 引用而非明文（铁律回归）", async () => {
    const io = makeIo();
    const code = await runProviderSubcommand(["provider", "import", "openrouter"], io);
    expect(code).toBe(0);
    const toml = readFileSync(io.configPath, "utf8");
    expect(toml).toContain("[provider-custom.providers.openrouter]");
    expect(toml).toContain('apiKey = "$ENV:OPENROUTER_API_KEY"');
    expect(toml).not.toContain("sk-");
  });

  it("缺端点条目 → exit 1 并提示 --baseUrl", async () => {
    const io = makeIo();
    const code = await runProviderSubcommand(["provider", "import", "no-endpoint-vendor"], io);
    expect(code).toBe(1);
    expect(io.lines.join("\n")).toContain("--baseUrl");
    expect(existsSync(io.configPath)).toBe(false);
  });

  it("provider list → 本地已配置与目录厂商两张表", async () => {
    const io = makeIo({}, true);
    await runProviderSubcommand(["provider", "import", "openrouter"], io);
    const io2 = { ...makeIo({}, true), configPath: io.configPath }; // out 闭包捕获本 io 自己的数组
    const code = await runProviderSubcommand(["provider", "list"], io2);
    expect(code).toBe(0);
    const out = io2.lines.join("\n");
    expect(out).toContain("openrouter");           // 本地表
    expect(out).toContain("no-endpoint-vendor");   // 目录表
  });

  it("--key 采集 → secrets.env 追加行（0o600，POSIX）+ config 只落引用", async () => {
    const io = makeIo();
    const code = await runProviderSubcommand(["provider", "import", "openrouter", "--key", "sk-abc123"], io);
    expect(code).toBe(0);
    const secret = readFileSync(io.secretsPath, "utf8");
    expect(secret).toContain("OPENROUTER_API_KEY=sk-abc123");
    if (process.platform !== "win32") expect(statSync(io.secretsPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(io.configPath, "utf8")).not.toContain("sk-abc123");
  });

  it("env_key 已在环境 → import 全程零输入（不创建 secrets 文件）", async () => {
    const io = makeIo({ OPENROUTER_API_KEY: "sk-live" });
    const code = await runProviderSubcommand(["provider", "import", "openrouter"], io);
    expect(code).toBe(0);
    expect(existsSync(io.secretsPath)).toBe(false);
    expect(readFileSync(io.configPath, "utf8")).toContain("$ENV:OPENROUTER_API_KEY");
  });
});
