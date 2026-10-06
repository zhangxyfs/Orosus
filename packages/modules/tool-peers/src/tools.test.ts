import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool, ToolContext } from "@orosus/contracts/tool";
import type { LlmPort } from "@orosus/contracts/module";
import { PeersEnv } from "./env.ts";
import { listNotes } from "./memstore.ts";
import { createMemoryTools, createPeersTools } from "./tools.ts";

let root: string;
let env: PeersEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "peers-tools-"));
  env = new PeersEnv({ workspaceMemory: false, sessionPeers: true, injectIndex: true, windowMinutes: 10, leaseMinutes: 30, sessionsRoot: root, memoryBase: join(root, "mem") });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// ToolContext 夹具（mcp preload.test.ts:75 先例——裸调 execute 在 typecheck 门必红 TS2554）
const tctx = (): ToolContext => ({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
const run = async (t: Tool, input: unknown): Promise<string> => (await (await t.resolveExecution(input)).execute(tctx())).output;

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
/** 信封 type 为末键——样例行手拼保键序（jsonl 序列化口径）。 */
const toolCallLine = (name: string, args: Record<string, unknown>, msAgo: number) =>
  `{"callId":"c1","name":"${name}","args":${JSON.stringify(args)},"v":1,"id":"e3","parentId":"e2","seq":3,"ts":${JSON.stringify(iso(msAgo))},"type":"tool/call"}`;
const assistantLine = (text: string) =>
  `{"content":[{"kind":"text","text":${JSON.stringify(text)}}],"v":1,"id":"e5","parentId":"e4","seq":5,"ts":${JSON.stringify(iso(30_000))},"type":"assistant/message"}`;

/** s_a = 活兄弟（本进程 pid 锁 + 写触碰 + label + claims）；s_b = 死兄弟（空目录）。 */
const makeSiblings = (): void => {
  const a = join(root, "D--proj-abc12345", "s_a");
  mkdirSync(join(a, "agents"), { recursive: true });
  writeFileSync(join(a, "agents", "session.lock"), `${process.pid}\n${iso(60_000)}\n`);
  writeFileSync(join(a, "agents", "session.jsonl"), [
    toolCallLine("tool-fs__write", { path: "src/bar.ts" }, 120_000),
    toolCallLine("tool-fs__edit", { path: "src/foo.ts" }, 180_000),
    assistantLine("I am refactoring the session tree store to fix chain forking"),
  ].join("\n") + "\n");
  writeFileSync(join(a, "claims.json"), JSON.stringify([{ file: "src/foo.ts", since: now - 60_000, until: now + 22 * 60_000 }]));
  mkdirSync(join(root, "D--proj-abc12345", "s_b"), { recursive: true });   // 无锁无文件 = 死
  mkdirSync(join(root, "D--proj-abc12345", "s_self", "agents"), { recursive: true });
  env.onSessionStart({ session_id: "s_self", transcript_path: join(root, "D--proj-abc12345", "s_self", "agents", "session.jsonl"), cwd: root });
};

const fakeLlm = (text: string, counter: { n: number }): LlmPort => ({
  stream: async function* () {
    counter.n++;
    yield { type: "text/delta", text } as never;
  },
});
const failingLlm = (): LlmPort => ({
  stream: async function* () {
    yield { type: "text/delta", text: "partial that must be discarded" } as never;
    yield { type: "finish", kind: "error" } as never;
  },
});

describe("peers/claim/release tools", () => {
  it("peers lists the live sibling with claim and touch (model summary — D9)", async () => {
    makeSiblings();
    const calls = { n: 0 };
    const [peersTool] = createPeersTools(env, fakeLlm("Refactoring session tree store", calls));
    const out = await run(peersTool, {});
    expect(out).toContain("(1, excluding self)");
    expect(out).toContain("s_a");
    expect(out).toContain("«Refactoring session tree store»");
    expect(out).toContain("Claimed: src/foo.ts");
    expect(out).toContain("Touched");
    expect(out).toContain("src/bar.ts");
  });

  it("summary cache: second peers call does not re-invoke llm (mtime unchanged, within 60s)", async () => {
    makeSiblings();
    const calls = { n: 0 };
    const [peersTool] = createPeersTools(env, fakeLlm("Refactoring session tree store", calls));
    await run(peersTool, {});
    await run(peersTool, {});
    expect(calls.n).toBe(1);
  });

  it("llm failure falls to mechanical preview (40 chars) — D9 degradation layer 2", async () => {
    makeSiblings();
    const [peersTool] = createPeersTools(env, failingLlm());
    const out = await run(peersTool, {});
    const preview = "I am refactoring the session tree store to fix chain forking".slice(0, 40);
    expect(out).toContain(preview);   // 40 字符截断（ZCode 同款）
  });

  it("focused peers({file}) shows claimant and touch", async () => {
    makeSiblings();
    const [peersTool] = createPeersTools(env, undefined);
    const out = await run(peersTool, { file: "src/foo.ts" });
    expect(out).toContain("File src/foo.ts");
    expect(out).toContain("claimed by");
    expect(out).toContain("Advisory, not a lock.");
  });

  it("empty state when no other live sessions", async () => {
    mkdirSync(join(root, "D--proj-abc12345", "s_self", "agents"), { recursive: true });
    env.onSessionStart({ session_id: "s_self", transcript_path: join(root, "D--proj-abc12345", "s_self", "agents", "session.jsonl"), cwd: root });
    const [peersTool] = createPeersTools(env, undefined);
    const out = await run(peersTool, {});
    expect(out).toContain("No other live sessions");
  });

  it("claim→release round-trip writes claims.json and reports", async () => {
    makeSiblings();
    const [, claimTool, releaseTool] = createPeersTools(env, undefined);
    const out = await run(claimTool, { files: ["src/mine.ts"], minutes: 15 });
    expect(out).toContain("src/mine.ts");
    expect(out).toContain("15 min");
    const claims = JSON.parse((await import("node:fs")).readFileSync(join(root, "D--proj-abc12345", "s_self", "claims.json"), "utf8")) as Array<{ file: string; until: number }>;
    expect(claims).toHaveLength(1);
    expect(claims[0]?.file).toBe("src/mine.ts");
    expect(claims[0]?.until).toBeGreaterThan(now + 14 * 60_000);
    const rel = await run(releaseTool, { files: ["src/mine.ts"] });
    expect(rel).toContain("Released");
    expect(env.readClaims(now)).toHaveLength(0);
  });

  it("claim warns when file is occupied by another session (advisory, still succeeds)", async () => {
    makeSiblings();
    const [, claimTool] = createPeersTools(env, undefined);
    const out = await run(claimTool, { files: ["src/foo.ts"] });
    expect(out).toContain("WARNING");
    expect(env.readClaims(now).map(c => c.file)).toContain("src/foo.ts");
  });

  it("session context not ready before boot", async () => {
    const [peersTool] = createPeersTools(env, undefined);
    const out = await run(peersTool, {});
    expect(out).toContain("session context not ready");
  });
});

describe("memory__write/list/read tools", () => {
  it("write→list→read round-trip: note file + MEMORY.md index line + body back", async () => {
    makeSiblings();
    const [w, l, r] = createMemoryTools(env);
    const out = await run(w, { title: "Anchor Style", summary: "how to cite code", content: "Use file:line always." });
    expect(out).toContain("index updated");
    expect(out).toContain("next turn");
    const memDir = env.memoryDir()!;
    const file = listNotes(memDir)[0]!.file;
    expect((await import("node:fs")).readFileSync(join(memDir, "MEMORY.md"), "utf8")).toContain("- [Anchor Style](");
    const list = await run(l, {});
    expect(list).toContain("Anchor Style");
    expect(list).toContain(file);
    const rd = await run(r, { file });
    expect(rd).toContain("Use file:line always.");
  });

  it("same title updates existing note (D25 查重)", async () => {
    makeSiblings();
    const [w] = createMemoryTools(env);
    await run(w, { title: "Anchor", summary: "v1", content: "body1" });
    const out2 = await run(w, { title: "Anchor", summary: "v2", content: "body2" });
    expect(out2).toContain("Updated");
    expect(listNotes(env.memoryDir()!)).toHaveLength(1);
  });

  it("read missing note → isError with Chinese message", async () => {
    makeSiblings();
    const [, , r] = createMemoryTools(env);
    const res = await (await r.resolveExecution({ file: "nope.md" })).execute(tctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("笔记不存在");
  });

  it("session context not ready → friendly output", async () => {
    const [w] = createMemoryTools(env);
    const out = await run(w, { title: "x", summary: "y", content: "z" });
    expect(out).toContain("session context not ready");
  });

  it("D25 discipline is stated in memory__write description (禁记/查重关键句)", async () => {
    const [w] = createMemoryTools(env);
    expect(w.description).toContain("DO NOT write");
    expect(w.description).toContain("UPDATE an existing note");
  });
});
