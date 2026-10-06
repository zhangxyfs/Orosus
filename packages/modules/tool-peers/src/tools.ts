import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LlmPort } from "@orosus/contracts/module";
import { defineTool, type Tool } from "@orosus/contracts/tool";
import { z } from "zod";
import { isSessionLive, normalizePath, parseClaims, parseToolCallLine, readLabel, readTailLines, WRITE_TOOL_NAMES, type Claim } from "./derive.ts";
import type { PeersEnv } from "./env.ts";

// 模型面英文（D11）；铁律句 qwen 先例 + advisory 句 dsh 化用（v4 定案原文）
const PEERS_RULE = "Other sessions are peers, not your workers — do not delegate this session's work to them.";
const ADVISORY_RULE = "File occupancy is advisory, not a lock — decide yourself whether to wait, work on something else, or ask the user.";
const NOT_READY = "session context not ready — this module needs the session to start (or be re-enabled mid-session) before it can see project peers.";

const SUMMARY_SYSTEM = "You summarize what another coding session is doing, based on its recent tool calls and messages. Reply with ONE short sentence (max ~15 words) in the language of the activity you see. No preamble.";

/** 「在干嘛」摘要（D9 v3 翻案 v9 四层降级链）：模型总结 → 机械预览（尾部 assistant 文本 40 字）→ session/label → sid 前 8 位。
 *  缓存按 (sid, 日志 mtime) 失效 + 60s 龄门（m5-agentview-perf liveCache 先例）——缓存命中零成本零二调。 */
const summaryCache = new Map<string, { mtimeMs: number; text: string; at: number }>();

function activityDigest(lines: string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (line.endsWith(`,"type":"tool/call"}`)) {
      const c = parseToolCallLine(line);
      if (c !== undefined) parts.push(`tool ${c.name}${typeof c.args["path"] === "string" ? ` ${c.args["path"]}` : ""}`);
    } else if (line.endsWith(`,"type":"assistant/message"}`)) {
      for (const t of assistantTexts(line)) parts.push(`assistant: ${t}`);
    }
  }
  return parts.join("\n").slice(-2_000);
}

function assistantTexts(line: string): string[] {
  try {
    const e = JSON.parse(line) as { content?: unknown };
    if (!Array.isArray(e.content)) return [];
    return e.content.filter(p => (p as { kind?: string })?.kind === "text").map(p => (p as { text?: string }).text ?? "");
  } catch { return []; }
}

/** 降级层 2：尾部最后一条 assistant 文本截 N 字（ZCode lastAssistantPreview 同款零成本）。 */
function mechanicalPreview(lines: string[], maxChars: number): string {
  let text = "";
  for (const line of lines) {
    if (!line.endsWith(`,"type":"assistant/message"}`)) continue;
    const joined = assistantTexts(line).join(" ").trim();
    if (joined !== "") text = joined;
  }
  return text.slice(0, maxChars);
}

async function summarizePeer(llm: LlmPort | undefined, sid: string, tailLines: string[], logFile: string, now: number): Promise<string> {
  let mtimeMs = 0;
  try { mtimeMs = statSync(logFile).mtimeMs; } catch { /* 无主日志 */ }
  const hit = summaryCache.get(sid);
  if (hit !== undefined && hit.mtimeMs === mtimeMs && now - hit.at < 60_000) return hit.text;
  let text = "";
  if (llm !== undefined && tailLines.length > 0) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3_000);
    try {
      for await (const c of llm.stream({
        system: SUMMARY_SYSTEM,
        messages: [{ role: "user", content: [{ kind: "text", text: activityDigest(tailLines) }] }],
        maxTokens: 100, signal: ac.signal,
      })) {
        if (c.type === "text/delta") text += c.text;
        else if (c.type === "finish" && c.kind === "error") { text = ""; break; }   // 错误带内（LlmPort 契约）
      }
    } catch { text = ""; }
    finally { clearTimeout(timer); }
    text = text.trim();
  }
  if (text === "") text = mechanicalPreview(tailLines, 40);
  if (text === "") text = readLabel(tailLines, "");
  if (text === "") text = sid.slice(0, 8);
  summaryCache.set(sid, { mtimeMs, text, at: now });
  return text;
}

const formatAgo = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1_000));
  if (s < 60) return s <= 5 ? "just now" : `${s} sec ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
};

const formatLeft = (until: number, now: number): string => `${Math.max(0, Math.round((until - now) / 60_000))} min left`;

interface TouchInfo { raw: string; norm: string; ts: number }

/** 写触碰的展示保真版：键归一化比对（D3），展示用原始路径（渲染样例口径）。 */
function deriveTouchList(lines: string[], now: number, windowMs: number): TouchInfo[] {
  const seen = new Map<string, TouchInfo>();
  for (const line of lines) {
    const c = parseToolCallLine(line);
    if (c === undefined || !WRITE_TOOL_NAMES.has(c.name) || c.ts <= 0 || now - c.ts > windowMs) continue;
    const p = c.args["path"];
    if (typeof p !== "string" || p === "") continue;
    const t = { raw: p, norm: normalizePath(p), ts: c.ts };
    const prev = seen.get(t.norm);
    if (prev === undefined || prev.ts < t.ts) seen.set(t.norm, t);
  }
  return [...seen.values()];
}

interface PeerView { sid: string; summary: string; claims: Claim[]; touches: TouchInfo[]; lastMs: number }

/** 活兄弟收集：lock/mtime 活性 → 尾读推导（sqlite 兄弟无 jsonl → D10 降级 claims-only）。 */
async function collectPeers(env: PeersEnv, llm: LlmPort | undefined, now: number): Promise<PeerView[]> {
  const views: PeerView[] = [];
  for (const { sid, dir } of env.siblingSessionDirs()) {
    if (!isSessionLive(dir, now, 90_000)) continue;
    const logFile = join(dir, "agents", "session.jsonl");
    const tailLines = existsSync(logFile) ? readTailLines(logFile) : [];
    let lastMs = 0;
    try { lastMs = statSync(logFile).mtimeMs; } catch { /* keep 0 */ }
    let claims: Claim[] = [];
    try { claims = parseClaims(readFileSync(join(dir, "claims.json"), "utf8"), now); } catch { /* 无声明 */ }
    const summary = await summarizePeer(llm, sid, tailLines, logFile, now);
    views.push({ sid, summary, claims, touches: deriveTouchList(tailLines, now, env.windowMs), lastMs });
  }
  return views;
}

function renderList(peers: PeerView[], now: number, windowMinutes: number): string {
  if (peers.length === 0) return "No other live sessions in this project.";
  const blocks = peers.map(p => {
    const lines = [`● «${p.summary}» (${p.sid}) — last activity ${p.lastMs > 0 ? formatAgo(now - p.lastMs) : "unknown"}`];
    if (p.claims.length > 0) lines.push(`  Claimed: ${p.claims.map(c => `${c.file} (${formatLeft(c.until, now)})`).join(", ")}`);
    if (p.touches.length > 0) lines.push(`  Touched within ${windowMinutes} min: ${p.touches.map(t => t.raw).join(", ")}`);
    return lines.join("\n");
  });
  return `Live peer sessions in this project (${peers.length}, excluding self):\n${blocks.join("\n\n")}\n\n${ADVISORY_RULE}`;
}

function renderFocus(file: string, peers: PeerView[], now: number): string {
  const norm = normalizePath(file);
  const claimants = peers.filter(p => p.claims.some(c => normalizePath(c.file) === norm));
  const touchers = peers.filter(p => p.touches.some(t => t.norm === norm));
  if (claimants.length === 0 && touchers.length === 0) {
    return `File ${file} is not claimed or touched by any live peer session.`;
  }
  const parts: string[] = [];
  if (claimants.length > 0) {
    parts.push(`claimed by ${claimants.map(p => `«${p.summary}» (${formatLeft(p.claims.find(c => normalizePath(c.file) === norm)!.until, now)})`).join(" and ")}`);
  }
  if (touchers.length > 0) {
    const latest = Math.max(...touchers.map(p => p.touches.find(t => t.norm === norm)!.ts));
    parts.push(`${claimants.length > 0 ? "also " : ""}touched ${formatAgo(now - latest)}`);
  }
  return `File ${file}: ${parts.join("; ")}. Advisory, not a lock.`;
}

/** 兄弟占用查询（撞检/聚焦共用）。 */
function claimsOf(peers: PeerView[], file: string): { peer: PeerView; claim: Claim }[] {
  const norm = normalizePath(file);
  const out: { peer: PeerView; claim: Claim }[] = [];
  for (const p of peers) { const c = p.claims.find(x => normalizePath(x.file) === norm); if (c !== undefined) out.push({ peer: p, claim: c }); }
  return out;
}

export function createPeersTools(env: PeersEnv, llm?: LlmPort): Tool[] {
  const peersTool = defineTool({
    name: "tool-peers__peers",
    description: `Query other live Orosus sessions working in this same project: their one-line activity summary, claimed files (lease-based), and files they recently wrote/edited (derived from their session logs). Pass { file } to focus on one file's occupancy. ${PEERS_RULE} ${ADVISORY_RULE}`,
    parameters: z.object({ file: z.string().min(1).optional() }),
    resolveExecution: async (input) => {
      const { file } = input as { file?: string };
      return {
        accesses: [],   // D6 免审批（tool-subagent spawn 先例）
        approvalRule: "tool-peers__peers",
        execute: async () => {
          if (env.self === undefined) return { output: NOT_READY, isError: false };
          const now = Date.now();
          const peers = await collectPeers(env, llm, now);
          return { output: file !== undefined ? renderFocus(file, peers, now) : renderList(peers, now, env.windowMs / 60_000), isError: false };
        },
      };
    },
  });

  const claimTool = defineTool({
    name: "tool-peers__claim",
    description: `Claim files you are about to edit so peer sessions in this project can see the occupancy (advisory, not a lock). Default lease 30 min — re-claim to extend. Check current occupancy first with tool-peers__peers. ${PEERS_RULE}`,
    parameters: z.object({
      files: z.array(z.string().min(1)).min(1),
      minutes: z.number().int().positive().optional(),
    }),
    resolveExecution: async (input) => {
      const { files, minutes } = input as { files: string[]; minutes?: number };
      return {
        accesses: [],
        approvalRule: "tool-peers__claim",
        execute: async () => {
          if (env.self === undefined) return { output: NOT_READY, isError: false };
          const now = Date.now();
          const until = now + (minutes !== undefined ? minutes * 60_000 : env.leaseMs);
          const kept = env.readClaims(now).filter(c => !files.some(f => normalizePath(f) === normalizePath(c.file)));
          env.writeClaims([...kept, ...files.map(file => ({ file, since: now, until }))]);
          // 撞他人占用：警告但成功（advisory）——指回查询工具（spec §9 qwen 先例）
          const peers = await collectPeers(env, undefined, now);
          const warnings = files.flatMap(f => claimsOf(peers, f).map(({ peer, claim }) =>
            `WARNING: ${f} is also claimed by «${peer.summary}» (${formatLeft(claim.until, now)}) — advisory, decide yourself; run tool-peers__peers for details.`));
          const lease = minutes !== undefined ? `${minutes} min` : "30 min";
          return {
            output: [
              `Claimed ${files.length} file(s) for ${lease}:`,
              ...files.map(f => `- ${f}`),
              ...warnings,
              "Occupancy is advisory, not a lock — other sessions see it via tool-peers__peers.",
            ].join("\n"),
            isError: false,
          };
        },
      };
    },
  });

  const releaseTool = defineTool({
    name: "tool-peers__release",
    description: "Release file claims you made with tool-peers__claim (pass files to release specific ones; omit to release all). Freed files immediately disappear from other sessions' tool-peers__peers output.",
    parameters: z.object({ files: z.array(z.string().min(1)).optional() }),
    resolveExecution: async (input) => {
      const { files } = input as { files?: string[] };
      return {
        accesses: [],
        approvalRule: "tool-peers__release",
        execute: async () => {
          if (env.self === undefined) return { output: NOT_READY, isError: false };
          const now = Date.now();
          const current = env.readClaims(now);
          if (current.length === 0) return { output: "No active claims to release.", isError: false };
          const toRelease = files ?? current.map(c => c.file);
          const kept = current.filter(c => !toRelease.some(f => normalizePath(f) === normalizePath(c.file)));
          const released = current.filter(c => toRelease.some(f => normalizePath(f) === normalizePath(c.file)));
          env.writeClaims(kept);
          return { output: `Released ${released.length} file(s): ${released.map(c => c.file).join(", ")}. ${kept.length} claim(s) remain.`, isError: false };
        },
      };
    },
  });

  return [peersTool, claimTool, releaseTool];
}
