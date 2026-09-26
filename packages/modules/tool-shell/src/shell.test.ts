import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveShell, lintCmdCommand, classifyFailure } from "./shell.ts";

/** win32 行为用例的公共环境（模拟典型 Windows 机器：SystemRoot + 系统 PATH，无 Git 候选）。 */
const baseEnv = { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" };

describe("resolveShell（壳解析：bash 命中优先，否则回落 shell:true）", () => {
  it("① POSIX 平台 → sh（shell:true 现状不变）", () => {
    expect(resolveShell({ platform: "linux", env: {}, exists: () => true })).toEqual({ kind: "sh" });
  });

  it("② win32 + OROSUS_TOOL_SHELL=cmd → 直接 cmd，不做探测（测试注入位 + 用户逃生口）", () => {
    const r = resolveShell({ platform: "win32", env: { ...baseEnv, OROSUS_TOOL_SHELL: "cmd" }, exists: () => true });
    expect(r).toEqual({ kind: "cmd" });
  });

  it("③ win32 + ProgramFiles 下有 Git\\bin\\bash.exe → bash", () => {
    const pf = "C:\\Program Files";
    const want = join(pf, "Git", "bin", "bash.exe");
    const r = resolveShell({ platform: "win32", env: { ...baseEnv, ProgramFiles: pf }, exists: (p) => p === want });
    expect(r).toEqual({ kind: "bash", bashPath: want });
  });

  it("④ ProgramFiles 未命中 → PATH 扫描补位（便携装/自定目录）", () => {
    const dir = "D:\\soft\\Git\\bin";
    const want = join(dir, "bash.exe");
    const r = resolveShell({
      platform: "win32",
      env: { ...baseEnv, PATH: `${baseEnv.PATH};${dir}` },
      exists: (p) => p === want,
    });
    expect(r).toEqual({ kind: "bash", bashPath: want });
  });

  it("⑤ System32 下的 bash.exe 是 WSL 桩——必须排除，回落 cmd", () => {
    const sys32 = "C:\\Windows\\System32";
    const r = resolveShell({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", PATH: sys32 },
      exists: (p) => p === join(sys32, "bash.exe"), // 只有 WSL 桩「存在」
    });
    expect(r).toEqual({ kind: "cmd" });
  });

  it("⑥ 全部候选未命中 → cmd（现状行为）", () => {
    expect(resolveShell({ platform: "win32", env: baseEnv, exists: () => false })).toEqual({ kind: "cmd" });
  });

  it("⑦ OROSUS_TOOL_SHELL=bash + 探测命中 → bash（显式指定）", () => {
    const pf = "C:\\Program Files";
    const want = join(pf, "Git", "bin", "bash.exe");
    const r = resolveShell({
      platform: "win32",
      env: { ...baseEnv, ProgramFiles: pf, OROSUS_TOOL_SHELL: "bash" },
      exists: (p) => p === want,
    });
    expect(r).toEqual({ kind: "bash", bashPath: want });
  });

  it("⑧ 优先级：ProgramFiles 已知路径胜过 PATH 扫描", () => {
    const pf = "C:\\Program Files";
    const known = join(pf, "Git", "bin", "bash.exe");
    const pathOne = join("D:\\Git\\bin", "bash.exe");
    const r = resolveShell({
      platform: "win32",
      env: { ...baseEnv, ProgramFiles: pf, PATH: `${baseEnv.PATH};D:\\Git\\bin` },
      exists: (p) => p === known || p === pathOne,
    });
    expect(r).toEqual({ kind: "bash", bashPath: known });
  });
});

describe("lintCmdCommand（cmd 方言护栏：POSIX 黑名单 + /dev/null 提示；undefined = 放行）", () => {
  it("① 管道尾部 head（走查截图 1/2 的原始案发形态）→ 拦截并点名", () => {
    const msg = lintCmdCommand("git diff --stat && echo ===== && git diff scripts/x.sh | head -60");
    expect(msg).toBeDefined();
    expect(msg).toContain("head");
    expect(msg).toContain("未执行");
  });

  it("② 首词 ls / && 链中的 tail → 拦截", () => {
    expect(lintCmdCommand("ls -la")).toContain("ls");
    expect(lintCmdCommand("echo ok && tail -1 f.txt")).toContain("tail");
  });

  it("③ 不误伤：git 子命令 / cmd 内建 / 现有测试 OK_CMD（引号内含 | 也不劈）", () => {
    expect(lintCmdCommand("git log --grep=fix")).toBeUndefined();
    expect(lintCmdCommand("git grep foo | cat")).toContain("cat"); // 管道尾部 cat 仍拦
    expect(lintCmdCommand(`node -e "process.stdout.write('ok')"`)).toBeUndefined();
    expect(lintCmdCommand(`node -e "console.log('a|b')"`)).toBeUndefined(); // 引号内的 | 不切分
    expect(lintCmdCommand("findstr /I \"toolview\"")).toBeUndefined();
    expect(lintCmdCommand("dir /b")).toBeUndefined();
    expect(lintCmdCommand("git status")).toBeUndefined();
  });

  it("④ 2>/dev/null → 拦截并提示 nul + 勿吞 stderr", () => {
    const msg = lintCmdCommand("git log --oneline 2>/dev/null");
    expect(msg).toBeDefined();
    expect(msg).toContain("/dev/null");
    expect(msg).toContain("stderr");
  });

  it("⑤ 教学文案给出替换建议（findstr / Select-Object）", () => {
    const msg = lintCmdCommand("cat a.txt | grep foo");
    expect(msg).toContain("findstr");
    expect(msg).toContain("Select-Object");
  });
});

describe("classifyFailure（第二道线：护栏漏网的「命令不存在」就地翻译）", () => {
  it("① cmd 文案（截图原文案）→ 命令不存在 + 点名", () => {
    const note = classifyFailure("'head' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。");
    expect(note).toBeDefined();
    expect(note).toContain("命令不存在");
    expect(note).toContain("head");
  });

  it("② bash 文案 → 命令不存在 + 点名", () => {
    const note = classifyFailure("bash: jq: command not found");
    expect(note).toBeDefined();
    expect(note).toContain("命令不存在");
    expect(note).toContain("jq");
  });

  it("③ 普通失败（git fatal 等）→ undefined，不画蛇添足", () => {
    expect(classifyFailure("fatal: not a git repository")).toBeUndefined();
  });
});
