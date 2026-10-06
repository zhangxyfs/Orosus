import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PeersEnv } from "./env.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "peers-env-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const boot = (env: PeersEnv) => env.onSessionStart({
  session_id: "s_self",
  transcript_path: join(root, "D--proj-abc12345", "s_self", "agents", "session.jsonl"),
  cwd: "D:/proj",
});

describe("PeersEnv", () => {
  it("derives self/bucket/sessionDir from session/start payload", () => {
    const env = new PeersEnv({ workspaceMemory: false, sessionPeers: false, injectIndex: true, windowMinutes: 10, leaseMinutes: 30, sessionsRoot: join(root, "sessions"), memoryBase: join(root, "mem") });
    expect(env.self).toBeUndefined();
    boot(env);
    expect(env.self?.sid).toBe("s_self");
    expect(env.self?.bucketDir).toBe(join(root, "D--proj-abc12345"));
    expect(env.memoryDir()).toBe(join(root, "mem", "D--proj-abc12345", "memory"));
  });
  it("bootById rescues mid-session enable (session/start never replays — D26)", () => {
    const env = new PeersEnv({ workspaceMemory: false, sessionPeers: false, injectIndex: true, windowMinutes: 10, leaseMinutes: 30, sessionsRoot: root });
    mkdirSync(join(root, "D--proj-abc12345", "s_self", "agents"), { recursive: true });
    writeFileSync(join(root, "D--proj-abc12345", "s_self", "agents", "session.jsonl"), "{}\n");
    expect(env.self).toBeUndefined();
    expect(env.bootById("s_self")).toBe(true);
    expect(env.self?.bucketDir).toBe(join(root, "D--proj-abc12345"));
    expect(env.bootById("s_missing")).toBe(false);
  });
  it("lists sibling session dirs excluding self", () => {
    const env = new PeersEnv({ workspaceMemory: false, sessionPeers: false, injectIndex: true, windowMinutes: 10, leaseMinutes: 30, sessionsRoot: root, memoryBase: join(root, "mem") });
    boot(env);
    for (const sid of ["s_self", "s_a", "s_b"]) mkdirSync(join(root, "D--proj-abc12345", sid), { recursive: true });
    expect(env.siblingSessionDirs().map(s => s.sid).sort()).toEqual(["s_a", "s_b"]);
  });
  it("round-trips claims with lease filter", () => {
    const env = new PeersEnv({ workspaceMemory: false, sessionPeers: false, injectIndex: true, windowMinutes: 10, leaseMinutes: 30, sessionsRoot: root, memoryBase: join(root, "mem") });
    boot(env);
    const now = Date.now();
    env.writeClaims([{ file: "src/a.ts", since: now, until: now + 60_000 }, { file: "src/g.ts", since: 0, until: now - 1 }]);
    expect(env.readClaims(now)).toHaveLength(1);
  });
});
