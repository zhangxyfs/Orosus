/** 面板数据端点（web 批 T7 本任务面）：GET /tasks 子代理名册（活名册 ∪ 盘上历史去重——§1 G3）、
 *  POST /subagents/:id/approval 后台子代理挂起审批应答、GET /subagents/:id/events transcript 回放
 *  （末 500——§5 自创值）。/panel 本体与 hooks-activity/compaction/diagnostics/launchers 属后续任务
 *  （§2 api-panel.ts 全清单——本文件只落 T7 三端点，YAGNI）。
 *  数据源全部走 CLI 纯函数件（tasks-cmd.ts——§2 依赖方向白名单）与 HostedSession.core 只读口；
 *  每请求现读（roster 是 O(册) 快照 + agents/ 目录 readdir，量级 = 单会话子代理数——panel 缓存 1s
 *  属 T10 /panel 装配面，此处不加）。 */
import type { ServerResponse } from "node:http";
import type { SubagentRosterEntry } from "@orosus/contracts/module";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import type { HostedSession } from "./hosted.ts";
import { agentEventsFromFile, loadHistoricalSubagents, sortNewestFirst } from "../tasks-cmd.ts";

/** 会话解析后的 JSON 体上限（approval {allow} 量级——send 1MiB 同款自创值口径，防失控客户端）。 */
const PANEL_BODY_MAX_BYTES = 1024 * 1024;

const notFound = (res: ServerResponse): void => {
  sendJson(res, 404, { ok: false, error: "not found" });
};

/** 会话解析（api-session 同口径）：host 优先（活名册源）；盘上未托管 → viewer 只读化身（历史/回放
 *  可用，活名册恒空——本进程无跑着的单子）；不在盘 → 404。 */
const resolveSession = async (sid: string): Promise<HostedSession | undefined> => {
  const pool = webHostPool();
  if (pool === undefined) return undefined;
  const hosted = pool.host(sid);
  if (hosted !== undefined) return hosted;
  return pool.viewer(sid).then(
    (hs) => hs,
    () => undefined, // 不在盘/装配失败——调用方 404
  );
};

/** GET /api/sessions/:sid/tasks → {ok, rows}（§3：rows = (SubagentRosterEntry & {historical?:boolean})[]）。
 *  口径（§1 G3 = CLI openTasks 同源，tasks-cmd.ts:420）：活名册（h.subagents——进行中全列 + 已结束
 *  保留 32）∪ 盘上历史（agents/ 目录重建，简述/后台/工种从主会话 spawn 调用回查），按 id 去重——
 *  活名册优先（状态新鲜带 pendingApproval/truncated 标注）；sortNewestFirst 最新在最上（孙代理亲缘
 *  经 parentId 标注，分组渲染归前端 T16）；历史重建行带 historical:true。 */
registerRoute("GET", "/api/sessions/:sid/tasks", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const live = hs.core?.subagents() ?? [];
  const liveIds = new Set(live.map((e) => e.id));
  const historical = loadHistoricalSubagents(hs.sessionsDir, hs.sid)
    .filter((e) => !liveIds.has(e.id))
    .map((e) => ({ ...e, historical: true }));
  const rows: Array<SubagentRosterEntry & { historical?: boolean }> = sortNewestFirst([...live, ...historical]);
  sendJson(res, 200, { ok: true, rows });
});

/** POST /api/sessions/:sid/subagents/:id/approval {allow:boolean} → {ok} | {ok,noop:true}（§3）。
 *  h.answerSubagentApproval(id,allow) 生效——allow 放行（子代理继续）/ false 拒绝；无挂起审批
 *  （未知 id/已答）→ noop 幂等形（answer 端点同口径——多端抢答先到先得）；缺 allow/非布尔 → 400。 */
registerRoute("POST", "/api/sessions/:sid/subagents/:id/approval", async (req, res, params) => {
  const sid = params["sid"] ?? "";
  const id = params["id"] ?? "";
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const raw = await readBody(req, PANEL_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { allow?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  if (typeof body.allow !== "boolean") {
    sendJson(res, 400, { ok: false, error: "allow 必须为布尔值" });
    return;
  }
  const h = hs.core;
  const delivered = h?.answerSubagentApproval(id, body.allow) ?? false;
  sendJson(res, 200, { ok: true, ...(delivered ? {} : { noop: true }) });
});

/** GET /api/sessions/:sid/subagents/:id/events → {ok, events}（§3 transcript 回放——末 500，§5 自创值）。
 *  agentEventsFromFile 直读（tasks-cmd 同源单口：路径形状 <桶>/<sid>/agents/agents_<id>/agents/
 *  session.jsonl，slice(-500) 截断）；文件不存在/未知 id → 空 events（200——「没有可回放的」不是
 *  错误，与 CLI 查看窗空态同语义）。事件为子代理会话文件原始行（无 seq 游标——append-only 全量
 *  末窗，分页属主会话回放面 T3，此处 §3 形状即全量末窗）。 */
registerRoute("GET", "/api/sessions/:sid/subagents/:id/events", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const id = params["id"] ?? "";
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const events = agentEventsFromFile(hs.sessionsDir, hs.sid, id);
  sendJson(res, 200, { ok: true, events });
});
