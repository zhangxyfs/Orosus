import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** T0 spike（m5-hooks）：钉「子进程协议往返」在本机壳形态下成立——stdin 喂一行 JSON、
 *  stdout 收回、退出码三态可辨。壳解析此处只取最小探测（ProgramFiles 系候选 + shell:true 回落），
 *  T5 执行器落 resolveShell 全形拷贝（tool-shell/src/shell.ts:18——铁律 2：模块不得 import tool-shell）。 */
function bashCandidate(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const bases = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LocalAppData"]];
  for (const base of bases) {
    if (!base) continue;
    const p = join(base, "Git", "bin", "bash.exe");
    if (existsSync(p)) return p;
  }
  return undefined;
}

function run(command: string, stdinText: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const bash = bashCandidate();
    const child = bash !== undefined
      ? spawn(bash, ["-c", command], { stdio: ["pipe", "pipe", "pipe"] })
      : spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => { out += d; });
    child.stderr!.on("data", (d) => { err += d; });
    child.on("error", rejectP);
    child.on("close", (code) => resolveP({ code, stdout: out, stderr: err }));
    child.stdin!.write(stdinText);
    child.stdin!.end();
  });
}

describe("m5-hooks T0 spike——子进程协议往返（Git Bash 路径）", () => {
  it("stdin 喂一行 JSON → cat 回 stdout → 退出码 0（放行形态往返）", async () => {
    const payload = { hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "ls" } };
    const r = await run("cat", JSON.stringify(payload) + "\n");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(JSON.stringify(payload));
  });

  it("退出码 2 + stderr 理由可辨（阻断形态）；理由走 stderr 不混 stdout", async () => {
    const r = await run('cat > /dev/null; echo "危险命令被拦" >&2; exit 2', JSON.stringify({ x: 1 }) + "\n");
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe("危险命令被拦");
    expect(r.stdout).toBe("");
  });
});
