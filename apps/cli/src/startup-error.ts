/** 启动错误面（T6/S7）：createHarness 抛错（坏配置 TOML、required 护栏阻断等）时的一句人话原因
 *  + 日志位置指引——替代 Node 裸堆栈。日期按 UTC 取（与 logger.ts 的 toISOString().slice(0, 10) 同式）。 */
import { t } from "./i18n/app.ts";

export function formatStartupError(err: unknown, home: string, now: Date): string {
  const reason = err instanceof Error ? err.message : String(err);
  return t("startup.fail", { reason: reason.split("\n")[0] ?? reason }) + "\n" + t("startup.failLog", { home, date: now.toISOString().slice(0, 10) });
}
