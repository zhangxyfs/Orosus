import type { Harness, SessionEvent } from "@orosus/core";

/** --print 单发输出（M4-2 T17/B17）——纯装配函数，不碰 process.exit（可测性——main 接线后以 exitCode 收尾）。
 *  三格式：text = 最后一条 assistant 正文 / json = {sessionId,model,usage,content} / stream-json = 事件流逐行 JSONL。 */
export interface PrintOutcome {
  /** 末条 turn/end 的 kind（命令路径无 turn = undefined）。
   *  CM-04③（2026-09-28 code review）：此前成功路径不查 turn 终态——provider 401/网络错误空正文仍 exit 0，
   *  管道消费方无法分辨失败；main 按 kind !== "completed" 置非零退出码。 */
  turnEndKind: "completed" | "interrupted" | "error" | undefined;
}

export async function runPrint(
  h: Harness, promptText: string, args: { model?: string; outputFormat?: "text" | "json" | "stream-json" },
  write: (s: string) => void,
): Promise<PrintOutcome> {
  const events: SessionEvent[] = [];
  // CM-04①：collect 吞 rejection——prompt 抛错（并发守卫/store IO）后事件通道若再 reject，
  // 残留 promise 无人 await = unhandledRejection 崩进程；收集失败按「已收即所得」，错误仍由 prompt 原样上抛
  const collect = (async () => { for await (const e of h.events()) events.push(e); })().catch(() => {});
  await h.prompt(promptText);
  // 此处 close 是事件收集的收口件（通道随 close 终止、collect 才 settle）——main 侧 finally 的 close 是
  // 错误路径清理 + 幂等兜底（CM-04 修后为显式契约，不再靠巧合）
  await h.close();
  await collect;
  const lastAssistant = events.filter((e) => e.type === "assistant/message").at(-1) as
    { content?: { kind?: string; text?: string }[]; usage?: unknown } | undefined;
  const text = lastAssistant !== undefined
    ? (lastAssistant.content ?? []).filter((p) => p.kind === "text").map((p) => p.text ?? "").join("")
    : "";
  if (args.outputFormat === "json") {
    write(JSON.stringify({ sessionId: h.sessionId, model: args.model, usage: lastAssistant?.usage, content: text }));
  } else if (args.outputFormat === "stream-json") {
    for (const e of events) write(JSON.stringify(e));
  } else {
    write(text);
  }
  const lastTurnEnd = events.filter((e) => e.type === "turn/end").at(-1) as { kind?: "completed" | "interrupted" | "error" } | undefined;
  return { turnEndKind: lastTurnEnd?.kind };
}
