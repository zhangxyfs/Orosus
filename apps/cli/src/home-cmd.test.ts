import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHomeSubcommand, runHomeSubcommand, type HomeIo } from "./home-cmd.ts";

/** `orosus home path` / `home migrate`（M4-2.5 T6——ROADMAP 迁移 ①②：dry-run/apply/双侧校验/留证不删）。 */
describe("orosus home migrate（M4-2.5 T6）", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const mkSource = (): string => {
    const src = mkdtempSync(join(tmpdir(), "orosus-t6-src-")); dirs.push(src);
    writeFileSync(join(src, "config.toml"), "model = \"x/y\"\n");
    mkdirSync(join(src, "sessions", "bucket-a"), { recursive: true });
    writeFileSync(join(src, "sessions", "bucket-a", "s1.jsonl"), "line1\nline2\n");
    writeFileSync(join(src, "sessions", "bucket-a", "s2.jsonl"), "line1\n");
    mkdirSync(join(src, "cache"), { recursive: true });
    writeFileSync(join(src, "cache", "models-dev.json"), "{}");
    return src;
  };
  const mkTarget = (): string => {
    const t = mkdtempSync(join(tmpdir(), "orosus-t6-dst-")); dirs.push(t);
    rmSync(t, { recursive: true, force: true }); // mkdtemp 建了空目录——目标语义 = 不存在
    return t;
  };
  const io = (src: string, extra: Partial<HomeIo> = {}): HomeIo => ({ sourceHome: src, env: {}, out: () => {}, ...extra });

  it("④ home path → 打印当前解析结果（装配层钉：isHomeSubcommand 拦截 + path 输出）", async () => {
    expect(isHomeSubcommand(["home", "path"])).toBe(true);
    expect(isHomeSubcommand(["home"])).toBe(true);
    expect(isHomeSubcommand(["chat"])).toBe(false);
    const lines: string[] = [];
    const src = mkSource();
    const code = await runHomeSubcommand(["home", "path"], { ...io(src), out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes(src))).toBe(true);
    expect(lines.some((l) => l.includes("config.toml") || l.includes("config"))).toBe(true);
  });

  it("⑤ 缺省 dry-run：列出计划（源/目标/文件数/字节）零复制零改名", async () => {
    const src = mkSource();
    const dst = mkTarget();
    const lines: string[] = [];
    const code = await runHomeSubcommand(["home", "migrate", dst], { ...io(src), out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("dry-run") || l.includes("计划"))).toBe(true);
    expect(lines.some((l) => l.includes("4 个文件"))).toBe(true); // config + 2 会话 + models-dev = 4 文件
    expect(existsSync(dst)).toBe(false);                            // 零复制
    expect(existsSync(`${src}.pre-migrate-`)).toBe(false);          // 零改名
  });

  it("⑥ --apply：复制 + 双侧校验 + 源改名 .pre-migrate-<ts> 留证（源文件仍在改名目录中）", async () => {
    const src = mkSource();
    const dst = mkTarget();
    const lines: string[] = [];
    const code = await runHomeSubcommand(["home", "migrate", dst, "--apply"], { ...io(src), out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(existsSync(join(dst, "config.toml"))).toBe(true);
    expect(existsSync(join(dst, "sessions", "bucket-a", "s1.jsonl"))).toBe(true);
    expect(existsSync(join(dst, "cache", "models-dev.json"))).toBe(true);
    const renamed = readdirSync(join(src, "..")).find((n) => n.startsWith(`${src.split(/[\\/]/).pop()!}.pre-migrate-`));
    expect(renamed).toBeDefined();                                  // 源已改名
    expect(existsSync(join(join(src, ".."), renamed!, "config.toml"))).toBe(true); // 源文件仍在（留证不删）
    expect(existsSync(src)).toBe(false);                            // 原位不再
  });

  it("⑦ 目标已存在且非空 → 拒绝（退出码 1，零动作）", async () => {
    const src = mkSource();
    const dst = mkdtempSync(join(tmpdir(), "orosus-t6-busy-")); dirs.push(dst);
    writeFileSync(join(dst, "occupied.txt"), "x");
    const code = await runHomeSubcommand(["home", "migrate", dst, "--apply"], io(src));
    expect(code).toBe(1);
    expect(existsSync(join(dst, "occupied.txt"))).toBe(true);
    expect(existsSync(src)).toBe(true);                              // 源不动
  });

  it("⑧ 校验失败（io.copy 注入复制后字节差）→ 清理目标 + 源不动 + 退出码 1", async () => {
    const src = mkSource();
    const dst = mkTarget();
    const { cpSync } = await import("node:fs");
    const code = await runHomeSubcommand(["home", "migrate", dst, "--apply"], {
      ...io(src),
      copy: (from, to) => {
        cpSync(from, to, { recursive: true });
        writeFileSync(join(to, "sessions", "bucket-a", "s1.jsonl"), "corrupted-bytes"); // 注入字节差
      },
    });
    expect(code).toBe(1);
    expect(existsSync(dst)).toBe(false);                             // 清理目标
    expect(existsSync(src)).toBe(true);                              // 源不动
    expect(statSync(join(src, "config.toml")).size).toBeGreaterThan(0);
  });
});
