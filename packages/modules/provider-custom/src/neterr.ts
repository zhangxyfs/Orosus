/** 网络层错误详情（2026-09-30 拍板 b）：undici 的 fetch 失败只给 "fetch failed" 一层皮，真实死因
 *  （ECONNRESET / Connect Timeout / socket hang up…）藏在 err.cause 链——此前只记 err.message，
 *  事后无从定位网络层真因（实锤：2026-09-30 fetch failed 杀回合，150s 挂起无迹可查）。walk 最多
 *  三层拼 "；cause: " 链进 errorMessage，同步进会话日志与诊断日志。非 Error 输入 String() 兜底。 */
export function netErrorDetail(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur instanceof Error; depth++) {
    if (cur.message !== "" && cur.message !== parts.at(-1)) parts.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  if (parts.length === 0) return String(err);
  return parts.join("；cause: ");
}
