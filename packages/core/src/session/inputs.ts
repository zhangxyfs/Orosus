import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSafeSessionId } from "./dir.ts";

/** 输入历史 sidecar（m5-resume-perf T13，D3）：`<桶>/<sid>/agents/inputs.jsonl`——每条用户键入
 *  一行 { ts, text }。与 session.jsonl 同目录同生命周期（空会话清理的 purgeSessionDir 自然连带）。
 *  五家同构（cc history.jsonl / codex batch / opencode localStorage store / qwen shell_history /
 *  ZCode input_history 表——无一从大会话转录做召回）：再大的会话也不影响召回速度；老会话无 sidecar
 *  由消费方降级镜像窗口翻（session-io inputHistoryFor，D3 世代交替语义——不为召回读全文件）。 */

const inputsFile = (dir: string, sessionId: string): string => join(dir, sessionId, "agents", "inputs.jsonl");

/** 写侧（best-effort）：每条 user/message 无条件记 typedText（原话优先、剥图片 chip——旁注
 *  host/input-echo 只在发出体≠原话时落主转录，sidecar 恒落、时序天然一致）；IO 失败吞——召回是
 *  辅助面不挡提交。双实例场景不加锁（session.lock 拒第二实例的 user/message append 前 sidecar 可能
 *  先落一行孤儿——召回池多一行的代价可接受，2026-10-05 doc-review 口径）。空串不记。 */
export function appendInput(dir: string, sessionId: string, text: string): void {
  if (text === "") return;
  if (!isSafeSessionId(sessionId)) return; // 防桶逃逸（main.ts 写侧恒合法——防御面与 store 构造同款）
  try {
    mkdirSync(join(dir, sessionId, "agents"), { recursive: true }); // 生产由 session.jsonl 懒建先在——幂等自足
    appendFileSync(inputsFile(dir, sessionId), JSON.stringify({ ts: new Date().toISOString(), text }) + "\n");
  } catch {
    /* 目录缺失/权限等——不挡提交 */
  }
}

/** 读侧：反向取尾部 limit 条（时间序返回——最新在末，与 inputHistoryTexts 同序）。文件天然小
 *  （纯用户输入、无工具输出）；防御帽 512KB——超帽只读尾段并丢弃可能被斩断的首行。坏行跳过。 */
export function readInputs(dir: string, sessionId: string, limit = 100): string[] {
  if (!isSafeSessionId(sessionId)) return [];
  try {
    const file = inputsFile(dir, sessionId);
    if (!existsSync(file)) return [];
    const st = statSync(file);
    if (st.size === 0) return [];
    const CAP = 512 * 1024;
    const n = Math.min(st.size, CAP);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(n);
      if (readSync(fd, buf, 0, n, st.size - n) !== n) return [];
      let s = buf.toString("utf8");
      if (n < st.size) s = s.slice(s.indexOf("\n") + 1); // 起点可能斩多字节/半行——丢首行
      const out: string[] = [];
      const lines = s.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (lines[i] === "") continue;
        try {
          const o = JSON.parse(lines[i]!) as { text?: unknown };
          if (typeof o.text === "string" && o.text !== "") out.push(o.text);
        } catch { /* 坏行跳过 */ }
      }
      return out.reverse(); // 时间序（最新在末）
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}
