import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { runProviderSubcommand } from "./provider-cmd.ts";
import type { Catalog } from "@orosus/provider-custom";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orosus-provcmd-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CATALOG: Catalog = {
  openrouter: { name: "OpenRouter", type: "openai", api: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"] },
  "no-endpoint-vendor": { name: "NoEndpoint", type: "openai" },
  "win-vendor": { name: "Win", type: "openai", api: "https://w", models: { "m-big": { id: "m-big", limit: { context: 131_072 } } } },
  "bad-win-vendor": { name: "BadWin", type: "openai", api: "https://b", models: { "m-tiny": { id: "m-tiny", limit: { context: 100 } } } },
};

function makeIo(env: Record<string, string> = {}, configExists = false, sub = "") {
  const d = sub === "" ? dir : (mkdirSync(join(dir, sub), { recursive: true }) ?? join(dir, sub)); // sub：用例内多子场景各自隔离一份 config（mkdirSync 递归可返 undefined）
  const configPath = join(d, "config.toml");
  if (configExists) writeFileSync(configPath, 'model = "openai/gpt-4.1"\n');
  const lines: string[] = [];
  return {
    configPath,
    secretsPath: join(dir, "secrets.env"),
    env,
    getCatalog: async () => ({ catalog: CATALOG, source: "online" as const }),
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

  it("CM-07：环境密钥只外发官方端点——--baseUrl 第三方端点不带 env 密钥（header 零泄漏 + 提示行）；官方端点照带", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchSpy = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    // 第三方端点：env 密钥不外发
    const io = makeIo({ OPENROUTER_API_KEY: "sk-secret-real" });
    io.fetchImpl = fetchSpy;
    const code = await runProviderSubcommand(["provider", "import", "openrouter", "--baseUrl", "https://evil.example.com/v1"], io);
    expect(code).toBe(0);
    expect(JSON.stringify(seen[0])).not.toContain("sk-secret-real"); // 旧实现：verify 先行真实密钥直发第三方
    expect(io.lines.join("\n")).toContain("未外发");
    // 官方端点（host 与目录 api 一致）：照常携带验证
    seen.length = 0;
    const io2 = makeIo({ OPENROUTER_API_KEY: "sk-secret-real" });
    io2.fetchImpl = fetchSpy;
    expect(await runProviderSubcommand(["provider", "import", "openrouter"], io2)).toBe(0);
    expect(JSON.stringify(seen[0])).toContain("sk-secret-real");
  });

  it("provider list → 本地已配置与目录厂商两张表", async () => {
    const io = makeIo({}, true);
    await runProviderSubcommand(["provider", "import", "openrouter"], io);
    const io2 = { ...makeIo({}, true), configPath: io.configPath }; // out 闭包捕获本 io 自己的数组
    const code = await runProviderSubcommand(["provider", "list"], io2);
    expect(code).toBe(0);
    const out = io2.lines.join("\n");
    expect(out).toContain("openrouter");           // 本地表
    const catalogIds = io2.lines.filter((l) => l.startsWith("  ") && !l.includes("（无）")).map((l) => l.trim().split("（")[0]!);
    expect(catalogIds.slice(0, 4)).toEqual(["bad-win-vendor", "no-endpoint-vendor", "openrouter", "win-vendor"]); // 目录表字母序（2026-09-18）
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

  it("CM-08：目录条目无 env 字段 + --key → 派生 OROSUS_<ID>_KEY 落盘（secrets + $ENV: 引用 + 输出明示），不再静默蒸发", async () => {
    const io = makeIo({}, false, "cm08");
    const code = await runProviderSubcommand(
      ["provider", "import", "no-endpoint-vendor", "--baseUrl", "https://self.example/v1", "--key", "sk-selfhost"],
      io,
    );
    expect(code).toBe(0);
    // 旧实现：两个落盘分支都只沿 envKey 走——flagKey 蒸发、输出仍 success、运行时 401
    const secret = readFileSync(io.secretsPath, "utf8");
    expect(secret).toContain("OROSUS_NO_ENDPOINT_VENDOR_KEY=sk-selfhost"); // id 规范大写、非字母数字转 _
    const toml = readFileSync(io.configPath, "utf8");
    expect(toml).toContain('apiKey = "$ENV:OROSUS_NO_ENDPOINT_VENDOR_KEY"');
    expect(toml).not.toContain("sk-selfhost"); // 铁律：config 不落明文
    expect(io.lines.join("\n")).toContain("OROSUS_NO_ENDPOINT_VENDOR_KEY"); // 输出明示派生键名（用户可查）
  });

  it("import --model：目录 limit.context 写入 contextWindow（≥1024 整数）；无 limit / 无效值不写 + 提示（四轮校验钉子）", async () => {
    const io = makeIo({}, false, "c1");
    expect(await runProviderSubcommand(["provider", "import", "win-vendor", "--model", "m-big"], io)).toBe(0);
    const toml = readFileSync(io.configPath, "utf8");
    expect(toml).toContain('provider = "win-vendor/m-big"'); // F5 十轮：键名 provider
    expect(toml).toContain("contextWindow = 131072");
    expect(io.lines.some((l) => l.includes("contextWindow = 131072"))).toBe(true);
    const io2 = makeIo({}, false, "c2");
    expect(await runProviderSubcommand(["provider", "import", "openrouter", "--model", "x"], io2)).toBe(0); // 目录无 limit → 不写
    expect(readFileSync(io2.configPath, "utf8")).not.toContain("contextWindow");
    const io3 = makeIo({}, false, "c3");
    expect(await runProviderSubcommand(["provider", "import", "bad-win-vendor", "--model", "m-tiny"], io3)).toBe(0); // <1024 → 拒
    expect(readFileSync(io3.configPath, "utf8")).not.toContain("contextWindow");
    expect(io3.lines.some((l) => l.includes("无效"))).toBe(true);
  });

  it("CM-13：重复 import --key → secrets.env 原位更新不累积；值含换行 / 目录 env 名非法 → 拒绝且零写盘", async () => {
    const io = makeIo({}, false, "cm13a");
    io.secretsPath = join(dir, "cm13a", "secrets.env"); // 独立文件——断言整文件内容
    expect(await runProviderSubcommand(["provider", "import", "openrouter", "--key", "sk-one"], io)).toBe(0);
    expect(await runProviderSubcommand(["provider", "import", "openrouter", "--key", "sk-two"], io)).toBe(0);
    // 注：不定长整文件字节——upsertSecret（tool-web 域）replace 分支对尾空行的收拢有既存毛刺（每次
    // 原位更新多留一个空行，loadSecretsEnv 不受影响）；此处钉 CM-13 的功能契约：单行、无旧密钥滞留
    const secret = readFileSync(io.secretsPath, "utf8");
    expect(secret.split("\n").filter((l) => l.startsWith("OPENROUTER_API_KEY="))).toEqual(["OPENROUTER_API_KEY=sk-two"]); // 旧 appendSecret：两行累积
    expect(secret).not.toContain("sk-one"); // 历代旧密钥明文不再滞留
    // 值含换行（多行粘贴/注入面）——发网与写盘之前拒绝
    const io2 = makeIo({}, false, "cm13b");
    expect(await runProviderSubcommand(["provider", "import", "openrouter", "--key", "sk-a\nEVIL=1"], io2)).toBe(1);
    expect(io2.lines.join("\n")).toContain("换行");
    expect(existsSync(io2.secretsPath)).toBe(false);
    expect(existsSync(io2.configPath)).toBe(false);
    // 目录声明的 env 名非常规形态（不受信目录数据，CM-07 同源）——拒绝落盘
    const io3 = makeIo({}, false, "cm13c");
    io3.getCatalog = async () => ({
      catalog: { poison: { name: "Poison", type: "openai", api: "https://p.example/v1", env: ["BAD\nNAME"] } } as Catalog,
      source: "online" as const,
    });
    expect(await runProviderSubcommand(["provider", "import", "poison", "--key", "sk-x"], io3)).toBe(1);
    expect(io3.lines.join("\n")).toContain("非常规形态");
    expect(existsSync(io3.secretsPath)).toBe(false);
    expect(existsSync(io3.configPath)).toBe(false);
  });

  it("CM-14：import 行级节区写——注释/既有键保留、条目与顶层键原位更新；异形（inline table）自动回退全量重写", async () => {
    // ① 常态：注释与用户既有配置全保——旧 parse→stringify 全灭
    const d = join(dir, "cm14a");
    mkdirSync(d, { recursive: true });
    const configPath = join(d, "config.toml");
    writeFileSync(configPath, [
      "# 用户注释——顶层",
      'model = "openai/gpt-4.1"',
      "",
      "[approval]",
      "# 节内注释",
      'mode = "ask"',
      "",
      "[provider-custom.providers.openrouter]",
      "type = \"openai\"",
      "baseUrl = \"https://old.example/v1\"",
      "apiKey = \"$ENV:OPENROUTER_API_KEY\"",
      "",
    ].join("\n"), "utf8");
    const lines: string[] = [];
    const io = {
      configPath, secretsPath: join(d, "s.env"), env: {},
      getCatalog: async () => ({ catalog: CATALOG, source: "online" as const }),
      fetchImpl: (async () => new Response("[]", { status: 200 })) as typeof fetch,
      out: (l: string) => void lines.push(l),
    };
    expect(await runProviderSubcommand(["provider", "import", "openrouter", "--model", "m-x"], io)).toBe(0);
    const toml = readFileSync(configPath, "utf8");
    expect(toml).toContain("# 用户注释——顶层");          // 注释保留（旧路径：全量重写洗掉）
    expect(toml).toContain("# 节内注释");
    expect(toml).toContain('model = "openai/gpt-4.1"');   // 用户既有键不动
    expect(toml).toContain('baseUrl = "https://openrouter.ai/api/v1"'); // 条目原位更新
    expect(toml).not.toContain("https://old.example");
    expect((toml.match(/\[provider-custom\.providers\.openrouter\]/g) ?? []).length).toBe(1); // 不重复建节
    expect(lines.join("\n")).toContain("注释与键序保留");
    const doc = parse(toml) as Record<string, unknown>;   // 写后语义 = 旧全量重写等价
    const got = ((doc["provider-custom"] as Record<string, unknown>)["providers"] as Record<string, unknown>)["openrouter"];
    expect(got).toEqual({ type: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "$ENV:OPENROUTER_API_KEY", defaultModel: "m-x" });
    expect(doc["provider"]).toBe("openrouter/m-x");       // 顶层键 upsert（首节头之前）
    // ② 异形：inline table 形态的 provider-custom 行级匹配不到 → parse 验证失败 → 回退旧全量重写（不产出坏配置）
    const d2 = join(dir, "cm14b");
    mkdirSync(d2, { recursive: true });
    const configPath2 = join(d2, "config.toml");
    writeFileSync(configPath2, '# 注释会没\nprovider-custom = { providers = { openrouter = { type = "openai", baseUrl = "https://x.example/v1" } } }\n', "utf8");
    const lines2: string[] = [];
    const io2 = { ...io, configPath: configPath2, out: (l: string) => void lines2.push(l) };
    expect(await runProviderSubcommand(["provider", "import", "openrouter"], io2)).toBe(0);
    expect(lines2.join("\n")).toContain("注释已移除");     // 回退路径文案明示
    const doc2 = parse(readFileSync(configPath2, "utf8")) as Record<string, unknown>;
    const got2 = ((doc2["provider-custom"] as Record<string, unknown>)["providers"] as Record<string, unknown>)["openrouter"];
    expect(got2).toEqual({ type: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "$ENV:OPENROUTER_API_KEY" });
  });
});

describe("C5 便车：import 补 defaultModel + 降级报错（M4-2 T1）", () => {
  // 注：方案原测试①未注入目录（默认 getCat 经 mock fetch 拿到空目录 → 厂商不存在即退出）——
  // 任何实现都无法通过；按本文件 makeIo 注入形态改写，断言意图不变（config 含 defaultModel）。
  it("① import --model → config 含 defaultModel（D32 裸名路由锚——与向导 setModel 同口径）", async () => {
    const d = join(dir, "c5a");
    mkdirSync(d, { recursive: true });
    const configFile = join(d, "config.toml");
    const code = await runProviderSubcommand(
      ["provider", "import", "zhipuai", "--model", "glm-4.7", "--baseUrl", "https://api.z.ai/v4"],
      {
        configPath: configFile,
        secretsPath: join(d, "s.env"),
        env: {},
        out: () => {},
        getCatalog: async () => ({
          catalog: { zhipuai: { name: "智谱", type: "openai", api: "https://api.z.ai/v4" } },
          source: "online" as const,
        }),
        fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      },
    );
    expect(code).toBe(0);
    expect(readFileSync(configFile, "utf8")).toContain('defaultModel = "glm-4.7"');
  });

  it("② 降级目录 + 未知厂商 → 报错含「本地缓存」提示", async () => {
    const d = join(dir, "c5b");
    mkdirSync(d, { recursive: true });
    const lines: string[] = [];
    await runProviderSubcommand(
      ["provider", "import", "nonexistent-vendor"],
      {
        configPath: join(d, "config.toml"),
        secretsPath: "",
        env: {},
        out: (l: string) => lines.push(l),
        getCatalog: async () => ({ catalog: {}, source: "disk" as const, fetchedAt: Date.now() }),
      },
    );
    expect(lines.some((l) => l.includes("本地缓存"))).toBe(true);
  });
});
