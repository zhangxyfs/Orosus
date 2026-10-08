import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PeersEnv } from "./env.ts";
import { encodeCwdLike, memoryBucketKey } from "./roots.ts";

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
    // T7：记忆桶键 = memoryBucketKey(cwd)（非 git 回退裸键），不再是会话桶 basename
    expect(env.memoryDir()).toBe(join(root, "mem", memoryBucketKey("D:/proj"), "memory"));
    expect(env.memoryDir()).not.toBe(join(root, "mem", "D--proj-abc12345", "memory"));
  });
  it("T7 坑 2 语义：git 仓库内从子目录启动，记忆桶 = 仓库根键（与导入目的地同桶）", () => {
    const env = new PeersEnv({ workspaceMemory: false, sessionPeers: false, injectIndex: true, windowMinutes: 10, leaseMinutes: 30, sessionsRoot: join(root, "sessions"), memoryBase: join(root, "mem") });
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "packages", "sub");
    mkdirSync(sub, { recursive: true });
    env.onSessionStart({ session_id: "s_sub", transcript_path: join(root, "B--sub", "s_sub", "agents", "session.jsonl"), cwd: sub });
    expect(env.memoryDir()).toBe(join(root, "mem", memoryBucketKey(repo), "memory"));
    expect(env.memoryDir()).not.toBe(join(root, "mem", encodeCwdLike(sub), "memory"));   // 不是子目录裸键（旧口径）
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
    expect(env.siblingSessionDirs().map(s => s.sid).toSorted()).toEqual(["s_a", "s_b"]);
  });
  it("round-trips claims with lease filter", () => {
    const env = new PeersEnv({ workspaceMemory: false, sessionPeers: false, injectIndex: true, windowMinutes: 10, leaseMinutes: 30, sessionsRoot: root, memoryBase: join(root, "mem") });
    boot(env);
    const now = Date.now();
    env.writeClaims([{ file: "src/a.ts", since: now, until: now + 60_000 }, { file: "src/g.ts", since: 0, until: now - 1 }]);
    expect(env.readClaims(now)).toHaveLength(1);
  });
});
