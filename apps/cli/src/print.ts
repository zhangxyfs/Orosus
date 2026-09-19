import type { Harness, SessionEvent } from "@orosus/core";

/** --print 单发输出（M4-2 T17/B17）——纯装配函数，不碰 process.exit（可测性——main 接线后以 exitCode 收尾）。
 *  三格式：text = 最后一条 assistant 正文 / json = {sessionId,model,usage,content} / stream-json = 事件流逐行 JSONL。 */
export async function runPrint(
  h: Harness, promptText: string, args: { model?: string; outputFormat?: "text" | "json" | "stream-json" },
  write: (s: string) => void,
): Promise<void> {
  const events: SessionEvent[] = [];
  const collect = (async () => { for await (const e of h.events()) events.push(e); })();
  await h.prompt(promptText);
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
}
