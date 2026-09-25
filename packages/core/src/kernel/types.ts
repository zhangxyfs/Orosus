import type { ModuleDefinition } from "@orosus/contracts/module";

/**
 * 模块生命周期状态（§5.3）。records 是结果快照：validated/resolved 是第 4/5 步的启动瞬时态，
 * 不落快照（启动完成时每个模块必为 active / failed / discovered 三者之一）；disposed 由 disposeAll 落。
 */
export type ModuleState = "discovered" | "validated" | "resolved" | "active" | "disposed" | "failed" | "pending-confirm"; // pending-confirm = m5 T17 待确认第三方（不进 failed 计数——它是待决不是失败）

export interface ModuleRecord {
  def: ModuleDefinition;
  name: string;
  source: "builtin" | "inline" | "local";
  state: ModuleState;
  failReason?: string;
  /** 代际按模块实例计（§5.5）：M1 恒为 1，reload（M2）起递增。 */
  generation: number;
}

/** 启动审计条目（§4.2 第 7 步 / --dump-modules 行）。 */
export interface AuditEntry {
  name: string;
  version: string;
  source: string;
  state: ModuleState;
  provides: string[];
  dependsOn: string[];
  contributes: string[];
  failReason?: string;
}
