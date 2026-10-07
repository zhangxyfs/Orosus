import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMenuDeps } from "./cli-deps.ts";

/** defaultMenuDeps.appendSecret 的真盘行为（MP-09 回归）。密封：OROSUS_HOME 指向 tmp 目录——
 *  orosusHome() 每次调用读 process.env（无模块级缓存），defaultMenuDeps 构造期解析 secretsPath，
 *  故先设 env 再构造即隔离，不碰真实 ~/.orosus。 */
describe("appendSecret 单行 upsert（MP-09：不累积重复行 + 换行拒绝）", () => {
  const dirs: string[] = [];
  const savedHome = process.env.OROSUS_HOME;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.OROSUS_HOME;
    else process.env.OROSUS_HOME = savedHome;
  });

  const homeInTmp = (): { home: string; secrets: string } => {
    const home = mkdtempSync(join(tmpdir(), "orosus-mp09-")); dirs.push(home);
    process.env.OROSUS_HOME = home;
    return { home, secrets: join(home, "secrets.env") };
  };

  it("① 同 key 二次写入 → 原地更新单行（MP-09 前：appendFileSync 纯追加，旧密钥明文行永久残留累积）", async () => {
    const { secrets } = homeInTmp();
    const deps = defaultMenuDeps();
    await deps.appendSecret("DEEPSEEK_API_KEY", "sk-old");
    await deps.appendSecret("DEEPSEEK_API_KEY", "sk-new");
    expect(readFileSync(secrets, "utf8")).toBe("DEEPSEEK_API_KEY=sk-new\n"); // 恰一行——旧值不残留
  });

  it("② 更新不动他行：既有文件里其他 key 原样保留，追加形态（文件不存在）首写建文件单行收尾", async () => {
    const { secrets } = homeInTmp();
    writeFileSync(secrets, "OTHER_KEY=keep\n# 注释行保留\n", "utf8");
    const deps = defaultMenuDeps();
    await deps.appendSecret("DEEPSEEK_API_KEY", "sk-1");
    expect(readFileSync(secrets, "utf8")).toBe("OTHER_KEY=keep\n# 注释行保留\nDEEPSEEK_API_KEY=sk-1\n");
    await deps.appendSecret("OTHER_KEY", "rotated");
    expect(readFileSync(secrets, "utf8")).toBe("OTHER_KEY=rotated\n# 注释行保留\nDEEPSEEK_API_KEY=sk-1\n"); // 只动目标行
  });

  it("③ 值含 \\n / \\r → 拒绝写入并抛可读错误（MP-09 前：向 secrets.env 注入额外行，形如 X=Y 的注入行被 loadSecretsEnv 静默生效）", async () => {
    const { secrets } = homeInTmp();
    const deps = defaultMenuDeps();
    await deps.appendSecret("K1", "sk-ok");
    const before = readFileSync(secrets, "utf8");
    await expect(deps.appendSecret("K2", "sk-a\nINJECTED=1")).rejects.toThrow(/换行/);
    await expect(deps.appendSecret("K3", "sk-b\rK3b")).rejects.toThrow(/换行/);
    expect(readFileSync(secrets, "utf8")).toBe(before); // 拒绝 = 零写入（文件与注入面均不变）
    expect(existsSync(secrets)).toBe(true);
  });
});

/** resolveKey $ENV 双源解析（2026-10-07 setDefault 补选模型件）：secrets.env → 进程环境。
 *  语义镜像 core loadSecretsEnv（后者覆盖、剥成对引号、# 注释跳过）——模块不 import core，本地最小实现。 */
describe("resolveKey（$ENV: 双源——secrets.env 后者覆盖，进程环境兜底）", () => {
  const dirs: string[] = [];
  const savedHome = process.env.OROSUS_HOME;
  const savedEnvKey = process.env.PROVIDER_TEST_KEY;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.OROSUS_HOME;
    else process.env.OROSUS_HOME = savedHome;
    if (savedEnvKey === undefined) delete process.env.PROVIDER_TEST_KEY;
    else process.env.PROVIDER_TEST_KEY = savedEnvKey;
  });

  it("① secrets.env 命中：后者覆盖、剥成对引号、# 注释与他行跳过；明文引用与 undefined 原样", () => {
    const home = mkdtempSync(join(tmpdir(), "orosus-reskey-")); dirs.push(home);
    process.env.OROSUS_HOME = home;
    writeFileSync(join(home, "secrets.env"), [
      "# 注释行跳过",
      "DEEPSEEK_API_KEY=\"sk-quoted-first\"",
      "OTHER=keep",
      "DEEPSEEK_API_KEY=sk-last", // 同 key 后者覆盖
    ].join("\n"), "utf8");
    const deps = defaultMenuDeps();
    expect(deps.resolveKey?.("$ENV:DEEPSEEK_API_KEY")).toBe("sk-last"); // 后者覆盖（首次成对引号被覆盖不生效）
    expect(deps.resolveKey?.("sk-plaintext")).toBe("sk-plaintext"); // 非 $ENV 引用：明文原样
    expect(deps.resolveKey?.(undefined)).toBeUndefined();
  });

  it("② 文件无此键 → 进程环境兜底；引号剥取首次命中值、成对才剥（loadSecretsEnv 同口径）", () => {
    const home = mkdtempSync(join(tmpdir(), "orosus-reskey2-")); dirs.push(home);
    process.env.OROSUS_HOME = home;
    process.env.PROVIDER_TEST_KEY = "sk-from-process-env";
    writeFileSync(join(home, "secrets.env"), "QUOTED=\"sk-quoted\"\nUNPAIRED=\"unpaired'\n", "utf8");
    const deps = defaultMenuDeps();
    expect(deps.resolveKey?.("$ENV:PROVIDER_TEST_KEY")).toBe("sk-from-process-env"); // 文件缺席回落进程环境
    expect(deps.resolveKey?.("$ENV:QUOTED")).toBe("sk-quoted"); // 成对引号剥
    expect(deps.resolveKey?.("$ENV:UNPAIRED")).toBe("\"unpaired'"); // 不成对按字面量
  });
});
