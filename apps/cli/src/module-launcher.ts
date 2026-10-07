/** 模块总览启动器（m5-peers T6e——A-1 极简版，D21/D22/D24）：
 *  宿主总键 Ctrl+P 开总览弹窗（buildLauncherOverlay——诊断弹窗同族几何），列出带 UI 的模块，
 *  Enter 执行其登记命令（io.submit——与用户手敲斜杠命令等效）。launcher 声明在 defineModule 上
 *  （contracts 入口参数），经 kernel audit() 透出（active 模块才收）。 */

export interface LauncherEntry { name: string; label: string; labelKey?: string; command?: string }

/** 空态文案（D24：诊断空态同款 toast 兜底）。 */
export const EMPTY_LAUNCHER_TOAST = "没有可打开的模块界面";

/** 翻译口（宿主 t；缺省回落声明原值——纯函数件无表可查时保底）。 */
export type LauncherT = (key: string, params?: Record<string, string | number>, fallback?: string) => string;

/** 收集 active 且登记了 launcher 的模块（按名稳定序——audit 已排序，此处保持防御性重排）。
 *  labelKey = 声明方自报的翻译键（contracts 2026-10-07 走查加），渲染端 t(labelKey, undefined, label)。 */
export function collectLaunchers(audit: { name: string; state: string; launcher?: { label: string; command?: string; labelKey?: string } }[]): LauncherEntry[] {
  return audit
    .filter(a => a.state === "active" && a.launcher !== undefined && a.launcher.label !== "")
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map(a => ({ name: a.name, label: a.launcher!.label, ...(a.launcher!.labelKey !== undefined ? { labelKey: a.launcher!.labelKey } : {}), ...(a.launcher!.command !== undefined ? { command: a.launcher!.command } : {}) }));
}

/** 弹窗列表行（2026-10-07 走查 i18n）：label 经 tr(labelKey) 翻译（回落声明原值）；
 *  「label —— command」形态走 launcher.row 键（menus 域已备）。无 command 只显 label。 */
export function launcherRows(entries: LauncherEntry[], tr?: LauncherT): string[] {
  const t = tr ?? ((_k, _p, f) => f ?? _k);
  return entries.map((e) => {
    const label = e.labelKey !== undefined ? t(e.labelKey, undefined, e.label) : e.label;
    return e.command !== undefined ? t("launcher.row", { label, command: e.command }, `${label} —— ${e.command}`) : label;
  });
}
