import type { ReloadReport } from "@orosus/core";

/** 原因取行首（失败 reason 可能多行，toast 单行只放第一行）。 */
const firstLine = (reason: string): string => reason.split("\n")[0] ?? reason;

/**
 * 热插拔 toast 文案（T2 修谎）：读 reload 报告的 failed 清单——失败时明说「挂载/卸载失败 + 原因」，
 * 不再按「用户按了挂载」假报成功。连带启停的成功名单不进 toast（S10 拍板：只报目标模块），
 * 只报失败连带；成功连带经 h.log 写诊断日志（T4 的 host.module.cascade）。
 */
export function toggleResultText(action: "mount" | "unmount", name: string, r: ReloadReport): string {
  const verb = action === "mount" ? "挂载" : "卸载";
  if (r.failed.length === 0) {
    return action === "mount"
      ? `已挂载 ${name}（reload：added ${r.added.join(",") || "无"}）`
      : `已卸载 ${name}（reload：removed ${r.removed.join(",") || "无"}）`;
  }
  const mine = r.failed.find((f) => f.name === name);
  const rest = r.failed.filter((f) => f.name !== name);
  const parts: string[] = [];
  parts.push(mine !== undefined
    ? `${verb}失败：${name}——${firstLine(mine.reason)}`
    : `已${verb} ${name}`);
  if (rest.length > 0) {
    parts.push(`连带失败：${rest.map((f) => `${f.name}（${firstLine(f.reason)}）`).join("、")}`);
  }
  return parts.join(mine !== undefined ? " " : "；");
}
