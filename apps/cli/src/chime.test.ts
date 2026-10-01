// chime 档（2026-10-01）：[tui] bell 三态解析 + 平台播放命令选型 + 终态过滤 + 资产在场钉。
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolveBellMode, playTurnChime, TURN_END_SOUND } from "./chime.ts";

describe("回合提示音 · chime 档", () => {
  it("① resolveBellMode：三态字符串直收 + 旧布尔兼容（true=bel/false=off）+ 缺省/非法回落 bel", () => {
    expect(resolveBellMode("chime")).toBe("chime");
    expect(resolveBellMode("bel")).toBe("bel");
    expect(resolveBellMode("off")).toBe("off");
    expect(resolveBellMode(true)).toBe("bel");
    expect(resolveBellMode(false)).toBe("off");
    expect(resolveBellMode(undefined)).toBe("bel");
    expect(resolveBellMode("CHIME")).toBe("bel"); // 大小写敏感——非法值回落
    expect(resolveBellMode(1)).toBe("bel");
  });

  it("② playTurnChime 平台选型：win=powershell SoundPlayer（含路径单引号转义）/ darwin=afplay / linux=paplay||aplay", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = (cmd: string, args: string[]): void => { calls.push({ cmd, args }); };
    playTurnChime("completed", { platform: "win32", run });
    expect(calls[0]!.cmd).toBe("powershell");
    expect(calls[0]!.args[0]).toBe("-NoProfile");
    expect(calls[0]!.args[2]).toContain("SoundPlayer");
    expect(calls[0]!.args[2]).toContain(TURN_END_SOUND);
    playTurnChime("completed", { platform: "darwin", run });
    expect(calls[1]!.cmd).toBe("afplay");
    expect(calls[1]!.args[0]).toBe(TURN_END_SOUND);
    playTurnChime("completed", { platform: "linux", run });
    expect(calls[2]!.cmd).toBe("sh");
    expect(calls[2]!.args[1]).toContain("paplay");
    expect(calls[2]!.args[1]).toContain("aplay");
  });

  it("③ 终态过滤：completed/interrupted/error 三可听终态各一声；未知终态不响", () => {
    const calls: string[] = [];
    const run = (cmd: string): void => { calls.push(cmd); };
    playTurnChime("completed", { run });
    playTurnChime("interrupted", { run });
    playTurnChime("error", { run });
    expect(calls).toHaveLength(3);
    playTurnChime("finish", { run });
    playTurnChime(undefined, { run });
    expect(calls).toHaveLength(3);
  });

  it("④ 资产在场钉：运行资产 wav 已随仓（缺失 = chime 档全线静默的回归哨）", () => {
    expect(existsSync(TURN_END_SOUND)).toBe(true);
  });
});
