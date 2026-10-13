/** 批次三 W4 伴生测试（真栈）：GET /api/sessions/:sid/subagents/:id/todo——子代理 todo 悬浮条数据面。
 *  口径（brief Step 1）：
 *  - 末条投影：子代理会话文件写两条 tool-todo/write（后一条全量覆盖）→ GET 断言只投影末条
 *    （panelTasksFromEvent 同源：content/status → text/state，in_progress→active 映射面一并钉住）；
 *  - 空态：无文件 / 有文件无 todo 事件 → {ok, tasks: []}（「没有清单」不是错误——events 端点同语义）；
 *  - 1s 缓存（panel 同款 TTL 口径）：窗内改盘不出新值、出窗即出新值；
 *  - 路由面：未知 sid → 404；:id 非 8 位 hex（%2F 穿越形态）→ 400（终审收口——id 直拼 agents_<id> 路径）。
 *  栈 = tasks.test.ts 同款真栈（runWebSubcommand handover + fabricate 盘上子代理 jsonl——
 *  tasks-cmd.test ㊺ 手法：路径形状 <sessionsDir>/<sid>/agents/agents_<id>/agents/session.jsonl）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
import { runWebSubcommand } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";

/** 投影行（brief Interfaces：{text, state}）。 */
type TodoRow = { text: string; state: "done" | "active" | "pending" };

/** 轮询等待（25ms 步进；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
	const deadline = Date.now() + ms;
	for (;;) {
		if (await pred()) return;
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, 25));
	}
};

/** 引导门放行形态 config.toml（type = "openai"——provider-custom 槽 schema 必填协议族；死端口即可，本面不发 prompt）。 */
const writeProviderConfig = (home: string, baseUrl: string): void => {
	writeFileSync(join(home, "config.toml"), `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "${baseUrl}"\ntype = "openai"\n`, "utf8");
};

/** 种子会话（header-only）。 */
const seedSession = async (home: string, cwd: string, sid: string): Promise<void> => {
	const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
	await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
	await store.close();
};

interface Stack {
	base: string;
	port: number;
	auth: Record<string, string>;
	stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（tasks.test.ts 同款）。 */
const startWeb = async (home: string, cwd: string, sid: string): Promise<Stack> => {
	const lines: string[] = [];
	const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
	await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
	const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
	return {
		base: `http://127.0.0.1:${inst.port}`,
		port: inst.port,
		auth: { "x-orosus-token": inst.token, connection: "close" },
		stop: async () => {
			shutdownWebServer("test");
			await run;
		},
	};
};

/** fabricate 盘上子代理 jsonl（tasks.test.ts 同款手法）：路径形状
 *  <sessionsDir>/<sid>/agents/agents_<id>/agents/session.jsonl。 */
const fabricateAgentJsonl = (home: string, cwd: string, sid: string, id: string, events: Array<Record<string, unknown>>): void => {
	const dir = join(home, "sessions", encodeCwd(cwd), sid, "agents", `agents_${id}`, "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
};

/** GET todo → 解析体。 */
const getTodo = async (s: Stack, sid: string, id: string): Promise<Response> =>
	fetch(`${s.base}/api/sessions/${sid}/subagents/${id}/todo`, { headers: s.auth });

describe("web W4（问题 2）：子代理 todo 悬浮条数据端点（真栈）", () => {
	const homes: string[] = [];
	const cwds: string[] = [];
	let prevHome: string | undefined;

	const tmpHome = (): string => {
		const h = mkdtempSync(join(tmpdir(), "orosus-web-w4-"));
		homes.push(h);
		return h;
	};
	const tmpCwd = (): string => {
		const c = mkdtempSync(join(tmpdir(), "orosus-web-w4-cwd-"));
		cwds.push(c);
		return c;
	};

	beforeEach(() => {
		prevHome = process.env["OROSUS_HOME"];
	});

	afterEach(() => {
		shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退
		if (prevHome === undefined) delete process.env["OROSUS_HOME"];
		else process.env["OROSUS_HOME"] = prevHome;
		for (const c of cwds.splice(0)) {
			try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
		}
		while (homes.length > 0) {
			const h = homes.pop()!;
			try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
		}
	});

	it("① 末条投影：两条 tool-todo/write（后一条全量覆盖）→ 只投影末条；in_progress→active / done→done / pending→pending 映射面", async () => {
		const home = tmpHome();
		process.env["OROSUS_HOME"] = home;
		writeProviderConfig(home, "http://127.0.0.1:9"); // 引导门放行（死端口——本用例不发 prompt）
		const cwd = tmpCwd();
		await seedSession(home, cwd, "s_w4a");
		// 两条写事件（载荷带 agentId——T2 落盘口径）：后一条全量覆盖，端点只取末条
		fabricateAgentJsonl(home, cwd, "s_w4a", "ab120042", [
			{ v: 1, id: "h1", ts: "2026-01-01T00:00:00.000Z", type: "session/header", parentSession: null },
			{ v: 1, id: "h2", ts: "2026-01-01T00:00:01.000Z", type: "user/message", content: [{ kind: "text", text: "查一下挂载点" }] },
			{ v: 1, id: "t1", ts: "2026-01-01T00:00:02.000Z", type: "tool-todo/write", todos: [{ content: "旧步骤一", status: "pending" }, { content: "旧步骤二", status: "done" }], agentId: "ab120042" },
			{ v: 1, id: "t2", ts: "2026-01-01T00:00:03.000Z", type: "tool-todo/write", todos: [{ content: "查资料", status: "in_progress" }, { content: "写报告", status: "pending" }, { content: "收尾", status: "done" }], agentId: "ab120042" },
		]);
		const s = await startWeb(home, cwd, "s_w4a");

		const r = await getTodo(s, "s_w4a", "ab120042");
		expect(r.status).toBe(200);
		const b = (await r.json()) as { ok: boolean; tasks: TodoRow[] };
		expect(b.ok).toBe(true);
		// 只投影末条（t2 全量覆盖 t1——「旧步骤」不得漏出）+ panelTasksFromEvent 映射面
		expect(b.tasks).toEqual([
			{ text: "查资料", state: "active" },
			{ text: "写报告", state: "pending" },
			{ text: "收尾", state: "done" },
		]);

		await s.stop();
	}, 60_000);

	it("② 空态：无文件 / 有文件无 todo 事件 → {ok:true, tasks:[]}；未知 sid → 404", async () => {
		const home = tmpHome();
		process.env["OROSUS_HOME"] = home;
		writeProviderConfig(home, "http://127.0.0.1:9");
		const cwd = tmpCwd();
		await seedSession(home, cwd, "s_w4b");
		// 有文件、无 todo 事件（纯消息流）
		fabricateAgentJsonl(home, cwd, "s_w4b", "cd990011", [
			{ v: 1, id: "h1", ts: "2026-01-01T00:00:00.000Z", type: "session/header", parentSession: null },
			{ v: 1, id: "h2", ts: "2026-01-01T00:00:01.000Z", type: "user/message", content: [{ kind: "text", text: "单步任务" }] },
			{ v: 1, id: "h3", ts: "2026-01-01T00:01:00.000Z", type: "turn/end", kind: "completed" },
		]);
		const s = await startWeb(home, cwd, "s_w4b");

		// 无文件（未知 id）→ 空表
		const none = await getTodo(s, "s_w4b", "00000000");
		expect(none.status).toBe(200);
		expect(await none.json()).toEqual({ ok: true, tasks: [] });
		// 有文件、无 todo 事件 → 空表
		const noTodo = await getTodo(s, "s_w4b", "cd990011");
		expect(noTodo.status).toBe(200);
		expect(await noTodo.json()).toEqual({ ok: true, tasks: [] });
		// 未知 sid → 404
		const nf = await getTodo(s, "s_none", "cd990011");
		expect(nf.status).toBe(404);

		await s.stop();
	}, 60_000);

	it("③ 1s 缓存（panel 同款 TTL 口径）：窗内改盘不出新值；出窗即出新值", async () => {
		const home = tmpHome();
		process.env["OROSUS_HOME"] = home;
		writeProviderConfig(home, "http://127.0.0.1:9");
		const cwd = tmpCwd();
		await seedSession(home, cwd, "s_w4c");
		const seedRows = [{ content: "首版", status: "in_progress" }];
		fabricateAgentJsonl(home, cwd, "s_w4c", "ef550021", [
			{ v: 1, id: "t1", ts: "2026-01-01T00:00:00.000Z", type: "tool-todo/write", todos: seedRows, agentId: "ef550021" },
		]);
		const s = await startWeb(home, cwd, "s_w4c");

		const r1 = await getTodo(s, "s_w4c", "ef550021");
		const b1 = (await r1.json()) as { tasks: TodoRow[] };
		expect(b1.tasks).toEqual([{ text: "首版", state: "active" }]);

		// 盘上追加第二条（全量覆盖——清单一变）；窗内紧接 GET 仍是旧投影（缓存命中，不重读盘）
		fabricateAgentJsonl(home, cwd, "s_w4c", "ef550021", [
			{ v: 1, id: "t1", ts: "2026-01-01T00:00:00.000Z", type: "tool-todo/write", todos: seedRows, agentId: "ef550021" },
			{ v: 1, id: "t2", ts: "2026-01-01T00:00:01.000Z", type: "tool-todo/write", todos: [{ content: "次版", status: "done" }], agentId: "ef550021" },
		]);
		const r2 = await getTodo(s, "s_w4c", "ef550021");
		expect(((await r2.json()) as { tasks: TodoRow[] }).tasks).toEqual([{ text: "首版", state: "active" }]);

		// 出窗（TTL 1s）→ 下一 GET 重读盘出新值
		await new Promise((r) => setTimeout(r, 1_100));
		const r3 = await getTodo(s, "s_w4c", "ef550021");
		expect(((await r3.json()) as { tasks: TodoRow[] }).tasks).toEqual([{ text: "次版", state: "done" }]);

		await s.stop();
	}, 60_000);

	it("④ 路径面：:id 非 8 位 hex → 400（%2F 单段穿越形态——终审 93d12907 收口，events 端点同款）", async () => {
		const home = tmpHome();
		process.env["OROSUS_HOME"] = home;
		writeProviderConfig(home, "http://127.0.0.1:9");
		const cwd = tmpCwd();
		await seedSession(home, cwd, "s_w4d");
		const s = await startWeb(home, cwd, "s_w4d");

		// %2F 在单段内存活分段（server.ts 分段→逐段 decodeURIComponent）→ 解码后 id="y/../../etc"——
		// id 直拼 agents_<id> 文件路径的穿越面，端点入口形态校验拦为 400
		const bad = await getTodo(s, "s_w4d", "y%2F..%2F..%2Fetc");
		expect(bad.status).toBe(400);
		const b = (await bad.json()) as { ok: boolean };
		expect(b.ok).toBe(false);

		await s.stop();
	}, 60_000);
});
