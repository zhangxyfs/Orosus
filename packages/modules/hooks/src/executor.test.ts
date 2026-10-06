import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInjectionGates, buildHookEnv, mergeInjections, parseHookJson, runHook, stripAnsiAndControl, type InjectionState } from "./executor.ts";

const dirs: string[] = [];
afterEach(async () => {
  // Windows 上垂死子进程（超时杀树竞速）可能还占着 cwd 句柄——重试容忍，清理失败不判测试红
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 4; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
  }
});

const proj = (): string => {
  const d = mkdtempSync(join(tmpdir(), "orosus-hookexec-"));
  dirs.push(d);
  return d;
};
const run = (command: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000) => {
  const projectDir = proj(); // 每次新鲜目录——上一测的 afterEach 已删旧目录，复用残留路径当 cwd 会 ENOENT
  return runHook(command, { hook_event_name: "PreToolUse", session_id: "s1", cwd: projectDir, ...payload }, { timeoutMs, projectDir });
};

describe("钩子执行器（m5-hooks T5）——真实子进程往返", () => {
  it("① pass 往返：exit 0 + stdin 载荷 snake_case 逐字段透传（含 agent_id 子代理身份准备位）", async () => {
    const p = proj();
    const r = await runHook("cat", { hook_event_name: "PreToolUse", session_id: "s_abc", transcript_path: "/t.jsonl", cwd: p, permission_mode: "ask-risky", tool_name: "tool-shell__bash", tool_input: { command: "ls" }, tool_use_id: "c1", agent_id: "agents_01" }, { timeoutMs: 10_000, projectDir: p });
    expect(r.kind).toBe("pass");
    const echoed = JSON.parse((r as { stdout: string }).stdout.trim());
    expect(echoed).toMatchObject({ hook_event_name: "PreToolUse", session_id: "s_abc", transcript_path: "/t.jsonl", permission_mode: "ask-risky", tool_name: "tool-shell__bash", tool_use_id: "c1", agent_id: "agents_01" });
  });

  it("② exit 2 → deny：reason 取 stderr（qwen 形态被拒看得见）", async () => {
    const r = await run("cat > /dev/null; echo 危险命令被拦 >&2; exit 2");
    expect(r).toMatchObject({ kind: "deny", reason: "危险命令被拦" });
  });

  it("③ exit 2 + stdout 合法 JSON deny：JSON 决策优先（reason 用 JSON 的，不用 stderr）", async () => {
    proj(); // 夹具初始化（返回值不消费；③用例不读项目路径）
    const r = await run(`cat > /dev/null; echo '{"permissionDecision":"deny","reason":"json-理由"}' ; echo stderr-理由 >&2; exit 2`);
    expect(r).toMatchObject({ kind: "deny", reason: "json-理由" });
  });

  it("④ exit 2 + stdout JSON allow：完整决策面优先——放行（Claude 语义：exit 2 是简写，JSON 是全貌）", async () => {
    const r = await run(`cat > /dev/null; echo '{"permissionDecision":"allow"}'; exit 2`);
    expect(r.kind).toBe("pass");
  });

  it("⑤ 其他非零 → 非阻塞错误（fail-open：永不 reject、带 stderr 摘要）", async () => {
    const r = await run("cat > /dev/null; echo 崩了 >&2; exit 1");
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("退出码 1");
    expect((r as { message: string }).message).toContain("崩了");
  });

  it("⑥ 超时杀树：sleep 5s 钩子 400ms 被杀（timeout 态，不挂等）", async () => {
    const p = proj();
    const t0 = Date.now();
    const r = await runHook("sleep 5", {}, { timeoutMs: 400, projectDir: p });
    expect(r.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("⑦ 输出截断：stdout 100KB → 采集帽 64KB", async () => {
    const r = await run("yes aaaaaaaa | head -c 100000");
    expect(r.kind).toBe("pass");
    expect((r as { stdout: string }).stdout.length).toBeLessThanOrEqual(64 * 1024 + 1);
  });

  it("⑧ JSON 解析同级展开：顶层 / hookSpecificOutput 内 / additional_context 蛇形三形态都认", () => {
    expect(parseHookJson('{"permissionDecision":"deny","reason":"顶层"}')).toMatchObject({ permissionDecision: "deny", reason: "顶层" });
    expect(parseHookJson('{"hookSpecificOutput":{"permissionDecision":"deny","reason":"内层"}}')).toMatchObject({ permissionDecision: "deny", reason: "内层" });
    expect(parseHookJson('{"additional_context":"蛇形"}')).toMatchObject({ additionalContext: "蛇形" });
    expect(parseHookJson('{"hookSpecificOutput":{"additionalContext":"注入正文"}}')).toMatchObject({ additionalContext: "注入正文" });
  });

  it("⑨ 形似非 JSON：以 { 开头但解析失败 → pass 无决策（非阻塞）", async () => {
    const r = await run("echo '{bad json'");
    expect(r.kind).toBe("pass");
    expect((r as { decision?: unknown }).decision).toBeUndefined();
  });

  it("⑩ 多余键容错：未知字段忽略、已知字段照取", () => {
    const d = parseHookJson('{"unknownField":"x","systemMessage":"y","permissionDecision":"ask","updatedInput":{"a":1}}');
    expect(d).toMatchObject({ permissionDecision: "ask", updatedInput: { a: 1 } });
    expect((d as Record<string, unknown>)["unknownField"]).toBeUndefined();
  });

  it("⑪ 模板展开 + 环境双发：${OROSUS_PROJECT_DIR} 展开、$OROSUS_PROJECT_DIR/$CLAUDE_PROJECT_DIR 双变量注入", async () => {
    const p = proj();
    writeFileSync(join(p, "marker.txt"), "x", "utf8");
    const r = await runHook('echo "$OROSUS_PROJECT_DIR|$CLAUDE_PROJECT_DIR"; test -f "${OROSUS_PROJECT_DIR}/marker.txt" && echo HAS_MARKER', {}, { timeoutMs: 10_000, projectDir: p });
    expect(r.kind).toBe("pass");
    const out = (r as { stdout: string }).stdout;
    expect(out).toContain(`${p}|${p}`);
    expect(out).toContain("HAS_MARKER");
  });

  it("⑫ buildHookEnv 纯函数：四关键词包含剔除（大小写不敏感）+ 双发注入 + 正常变量保留", () => {
    const env = buildHookEnv("/proj", {
      PATH: "/usr/bin",
      MY_TOKEN: "t",
      API_KEY: "k",
      API_KEY_2: "k2",
      MY_SECRET: "s",
      PASSWORD: "p",
      ssh_auth_sock: "/tmp/sock", // 小写包含 KEY? 否——ssh_auth_sock 不含四词（KEY 大小写不敏感包含 "KEY"…"auth"无）——保留（过宽面走查期收紧，登记在案）
      HOME: "/home/u",
    } as unknown as NodeJS.ProcessEnv);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["MY_TOKEN"]).toBeUndefined();
    expect(env["API_KEY"]).toBeUndefined();
    expect(env["API_KEY_2"]).toBeUndefined();
    expect(env["MY_SECRET"]).toBeUndefined();
    expect(env["PASSWORD"]).toBeUndefined();
    expect(env["ssh_auth_sock"]).toBe("/tmp/sock");
    expect(env["OROSUS_PROJECT_DIR"]).toBe("/proj");
    expect(env["CLAUDE_PROJECT_DIR"]).toBe("/proj");
  });

  it("⑬ 空 stdout：exit 0 无输出 → pass 无决策", async () => {
    const r = await run("cat > /dev/null");
    expect(r).toMatchObject({ kind: "pass", stdout: "" });
    expect((r as { decision?: unknown }).decision).toBeUndefined();
  });

  it("⑭ 采集帽解耦回归：40k 字符 additionalContext 的 JSON（>32KB 旧自埋雷帽）仍完整解析", async () => {
    const p = proj();
    const big = "注".repeat(20_000) + "x".repeat(20_000); // 40k 字符（UTF-8 下 60k+ 字节，JSON 文本 >40k）
    writeFileSync(join(p, "big.json"), JSON.stringify({ additionalContext: big }), "utf8");
    const r = await runHook(`cat ${JSON.stringify(join(p, "big.json"))}`, {}, { timeoutMs: 10_000, projectDir: p });
    expect(r.kind).toBe("pass");
    const d = (r as { decision?: { additionalContext?: string } }).decision;
    expect(d?.additionalContext?.length).toBe(40_000);
  });

  it("⑮ 注入三道闸：净化 → 单条 16k 帽（可读截断标记）→ 累计 64k 帽（超限 skip）；ANSI/C0/C1 剥、\\n 保留；包裹头防伪造", () => {
    const state: InjectionState = { injectedChars: 0 };
    const g1 = applyInjectionGates("PostToolUse", "普通注入", state);
    expect(g1.skipped).toBe(false);
    expect(g1.text).toContain("[非用户输入] 钩子注入（PostToolUse）");
    const g1n = applyInjectionGates("PostToolUse", "带名注入", state, "捕获归档"); // 走查修：name 显示名进包裹头（折叠行「<名> 注入」的解析源）
    expect(g1n.text).toContain("[非用户输入] 钩子注入（PostToolUse · 捕获归档）");
    const g2 = applyInjectionGates("PostToolUse", `\u001b[31m红\u001b[0m带色\n第二行`, state);
    expect(g2.text).toContain("红带色\n第二行"); // ANSI 剥、换行保留
    expect(stripAnsiAndControl("a\u0000b\u000Bc\u007Fd\u0085e")).toBe("abcde"); // C0（除 \t\n\r）+ DEL + C1
    const long = "字".repeat(17_000);
    const g3 = applyInjectionGates("SessionStart", long, state);
    expect(g3.truncated).toBe(true);
    expect(g3.text).toContain(`[截断：原文 17000 字符，保留前 16000]`);
    // 累计帽：单条帽把每条压到 ≤16k——循环注入 15k×6，第 5 条起越过 64k 帽被 skip
    let skipped = 0;
    for (let i = 0; i < 6; i++) {
      if (applyInjectionGates("SessionStart", "z".repeat(15_000), state).skipped) skipped++;
    }
    expect(skipped).toBeGreaterThanOrEqual(2); // ≈16k 起步 + 3×15k 后触顶，末两条 skip
  });

  it("⑯ 多钩子注入合并：#N 编号 + 空行连接（ZCode 式）", () => {
    expect(mergeInjections(["甲", "乙"])).toBe("#1 甲\n\n#2 乙");
  });
});
