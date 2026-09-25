/** 首挂确认弹窗内容（m5 T17，决策点 25/设计空白 19-21）：声明面人话清单——纯函数供装配与测试。
 *  只列 def 静态面（provides/dependsOn/mounts/uses/version——activate 之前全部静态信息可读）；
 *  不列 contributes（工具/命令/卡片等注册物是 activate 期注册的动态物，未确认模块从未激活恒拿不到，
 *  列了就是撒谎——四轮审查修正）；空项不显示；hash-changed 顶部加警示行；固定诚实行两句。 */

import type { WidgetSpec } from "@orosus/contracts/module";

export interface PendingModuleInfo {
  name: string;
  version: string;
  layer: "user" | "project";
  root: string;
  /** 信任判定拒因原文（含 hash-changed 判定）。 */
  reason: string;
  def: {
    provides?: readonly string[];
    dependsOn?: readonly (string | { capability: string; optional?: boolean })[];
    mounts?: readonly string[];
    uses?: readonly string[];
  };
}

const layerText = (layer: "user" | "project"): string =>
  layer === "user" ? "用户级（~/.orosus/modules）" : "项目级（<项目>/.orosus/modules）";

/** 依赖声明的人话形：字符串原样；可选形标注「（可选）」。 */
const depText = (d: string | { capability: string }): string =>
  typeof d === "string" ? d : `${d.capability}（可选）`;

/** 声明面控件清单（弹窗 widgets 主体，不含操作列表——装配方追加）。 */
export function declarationWidgets(info: PendingModuleInfo): WidgetSpec[] {
  const w: WidgetSpec[] = [
    { id: "head", kind: "text", text: `${info.name} · ${info.version}`, style: "accent" },
    { id: "src", kind: "kv", label: "来源", value: `${layerText(info.layer)} ${info.root}` },
  ];
  if (info.reason.includes("hash") || info.reason.includes("变更")) {
    w.push({ id: "changed", kind: "text", text: "⚠ 代码已变更，须重新确认", style: "warn" });
  }
  if ((info.def.provides ?? []).length > 0) {
    w.push({ id: "provides", kind: "kv", label: "提供", value: info.def.provides!.join("、") });
  }
  if ((info.def.dependsOn ?? []).length > 0) {
    w.push({ id: "dependsOn", kind: "kv", label: "依赖", value: info.def.dependsOn!.map(depText).join("、") });
  }
  if ((info.def.mounts ?? []).length > 0) {
    w.push({ id: "mounts", kind: "kv", label: "宿主口", value: info.def.mounts!.join("、") });
  }
  if ((info.def.uses ?? []).length > 0) {
    w.push({ id: "uses", kind: "kv", label: "声明使用", value: info.def.uses!.join("、") });
  }
  w.push(
    { id: "sep1", kind: "sep" },
    { id: "honest1", kind: "text", text: "工具/命令/卡片等注册物要激活时才注册——确认前看不到，这是本确认的边界", style: "muted" },
    { id: "honest2", kind: "text", text: "声明面只覆盖契约口——模块是主进程代码，契约外的系统能力它物理上也能碰，只确认你信得过的来源", style: "muted" },
    { id: "sep2", kind: "sep" },
  );
  return w;
}

/** 完整弹窗清单：声明面 + 操作列表（确认开启 / 取消）。onEvent 由装配方注入（activate index 0 = 确认）。 */
export function confirmDialogWidgets(info: PendingModuleInfo): WidgetSpec[] {
  return [...declarationWidgets(info), { id: "act", kind: "list", interactive: true, items: ["确认开启", "取消"] }];
}
