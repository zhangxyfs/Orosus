import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Disposer, Logger } from "@orosus/contracts/module";
import { Access, type Tool, type ToolExecution, type ToolResult } from "@orosus/contracts/tool";
import type { ToolSpec } from "@orosus/contracts/provider";
import { CORE_POINTS, type EventBus } from "../kernel/bus.ts";
import { createLogger, type DiagSink } from "../diag/logger.ts";

/** 单条工具输出上限（字节按 length 近似），超出截断 + 溢写 spill（§6.3）。 */
export const OUTPUT_LIMIT = 32768;

/** 阶段一产物（D40）：声明 + 执行闭包 + 调度/审批所需的判定件。
 *  ok:false = 墓碑/未知工具/参数校验失败/resolveExecution 抛错的带内短路——execute 直落结果、不触发 waterfall。 */
export type PlannedTool =
  | {
      ok: true;
      callId: string;
      name: string;
      owner: string;
      args: unknown;
      log: Logger;
      execution: ToolExecution;
      accesses: Access[];
      approvalRule: string;
      matchesRule?: (ruleArgs: string) => boolean;
    }
  | { ok: false; callId: string; result: ToolResult };

export interface ToolRegistry {
  register(tool: Tool, owner: string): Disposer;
  list(): Tool[];
  /** owner 名下的工具名（reload 墓碑标记用，§5.5）。 */
  namesByOwner(owner: string): string[];
  /** soft 摘除（§5.5）：名字保留占位、run 带内报错、specs 仍含名——tools 数组字节稳定。 */
  tombstone(name: string): void;
  specs(): ToolSpec[];
  /** 阶段一（D40）：声明产物——调度分组与审批预判的输入。 */
  plan(call: { id: string; name: string; args: unknown }): Promise<PlannedTool>;
  /** 阶段二（D40）：waterfall（payload 含 matchesRule 函数引用，审批带参规则判定）→ 执行 → 归一。 */
  execute(planned: PlannedTool, ctx: { signal: AbortSignal }): Promise<ToolResult>;
  /** 合成口（M1 语义不变）：单发调用面。 */
  run(call: { id: string; name: string; args: unknown }, ctx: { signal: AbortSignal }): Promise<ToolResult>;
}

/**
 * 两阶段执行管线（§6.3，D40 拆分）：
 * plan = resolveExecution（声明）+ 参数校验（失败短路为带内结果）；execute = tool/pre-execute waterfall（审批）
 * → execute → 归一（截断/spill）。run 为合成口（M1 语义不变）。loop 消费 plan/execute 做 §6.3 并发分组。
 * fail-closed 默认值：accesses 缺省 = kind:"all"；approvalRule 缺省 = 需要审批。
 */
export function createToolRegistry(opts: { bus: EventBus; sink: DiagSink; spillDir: string }): ToolRegistry {
  const tools: { tool: Tool; owner: string; tombstoned?: boolean }[] = [];

  return {
    register(tool, owner) {
      if (!tool.name.startsWith(`${owner}__`)) {
        throw new Error(`工具名 "${tool.name}" 未带 "${owner}__" 前缀（规则 4）`);
      }
      const existing = tools.find((t) => t.tool.name === tool.name);
      if (existing !== undefined && !existing.tombstoned) {
        throw new Error(`工具重名：${tool.name}`);
      }
      if (existing !== undefined) {
        // 墓碑位重注册（reload 的 Reloaded 模块）：同位新对象顶替，保持注册序（tools 数组字节稳定，§6.3）。
        // 新对象是必须的：旧实例的 remove-disposer 持旧 entry 引用——若原位复用同一对象，reload 后
        // 选择性拆除旧实例会把新实例的注册一起剪掉（走查实证：复活工具被 disposeOwners 误删）
        const revived: { tool: Tool; owner: string; tombstoned?: boolean } = { tool, owner };
        tools[tools.indexOf(existing)] = revived;
        return () => { revived.tombstoned = true; };
      }
      const entry = { tool, owner };
      tools.push(entry);
      return () => {
        const i = tools.indexOf(entry);
        if (i >= 0) tools.splice(i, 1);
      };
    },

    list() {
      return tools.map((t) => t.tool);
    },

    namesByOwner(owner: string): string[] {
      return tools.filter((t) => t.owner === owner).map((t) => t.tool.name);
    },

    tombstone(name: string): void {
      const entry = tools.find((t) => t.tool.name === name);
      if (entry !== undefined) entry.tombstoned = true;
    },

    specs() {
      return tools.map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
      }));
    },

    async plan(call): Promise<PlannedTool> {
      const entry = tools.find((t) => t.tool.name === call.name);
      if (entry?.tombstoned) {
        // §5.5 会话连续性：被换下模块的工具——tools 数组字节不动，调用带内报错，新会话（新 registry）自然消失
        return { ok: false, callId: call.id, result: { output: "该工具所属模块已在 reload 中变更，新会话生效", isError: true } };
      }
      if (!entry) {
        return { ok: false, callId: call.id, result: { output: `未知工具 "${call.name}"（该工具所属模块可能已降级或未安装）`, isError: true } };
      }
      const { tool, owner } = entry;
      const tlog: Logger = createLogger(opts.sink, owner);

      const parsed = tool.parameters.safeParse(call.args);
      if (!parsed.success) {
        return {
          ok: false,
          callId: call.id,
          result: {
            output: `参数校验失败：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            isError: true,
          },
        };
      }

      let execution;
      try {
        execution = await tool.resolveExecution(parsed.data);
      } catch (err) {
        return { ok: false, callId: call.id, result: { output: `resolveExecution 抛错：${String(err)}`, isError: true } };
      }
      // fail-closed 默认值（§6.3）：宽松只能由声明显式打开
      const accesses = execution.accesses ?? [Access.all()];
      const approvalRule = execution.approvalRule ?? `${call.name}(需要审批)`;

      // 码表纪律（§11.9）：核心码只用 kernel/loop/provider 前缀——工具两阶段归 kernel.tool.*
      tlog.debug("kernel.tool.two-phase", "阶段一完成", { call: call.id, name: call.name, approvalRule, accessKinds: accesses.map((a) => a.kind).join(",") });
      return {
        ok: true, callId: call.id, name: call.name, owner, args: call.args, log: tlog,
        execution, accesses, approvalRule,
        ...(execution.matchesRule !== undefined ? { matchesRule: execution.matchesRule } : {}),
      };
    },

    async execute(planned, { signal }): Promise<ToolResult> {
      if (!planned.ok) return planned.result;
      const veto = await opts.bus.waterfall(CORE_POINTS.toolPreExecute, {
        callId: planned.callId, name: planned.name, args: planned.args, accesses: planned.accesses,
        approvalRule: planned.approvalRule,
        ...(planned.matchesRule !== undefined ? { matchesRule: planned.matchesRule } : {}), // 审批带参规则判定（T2/D40）
      });
      if (veto) {
        return { output: veto.reason, isError: true, denied: true };
      }

      let result: ToolResult;
      try {
        result = await planned.execution.execute({ callId: planned.callId, signal, log: planned.log });
      } catch (err) {
        result = { output: `工具执行抛错：${String(err)}`, isError: true };
      }

      if (result.output.length > OUTPUT_LIMIT) {
        mkdirSync(opts.spillDir, { recursive: true });
        const path = join(opts.spillDir, `spill-${planned.callId}.txt`);
        writeFileSync(path, result.output, { mode: 0o600 });
        const bytes = result.output.length;
        result = {
          ...result,
          output: result.output.slice(0, OUTPUT_LIMIT) + `\n…[输出截断，全文 ${bytes}B 已溢写 ${path}]`,
          truncated: true,
          spill: { path, bytes },
        };
      }

      planned.log.debug("kernel.tool.result", "执行完成", { call: planned.callId, isError: result.isError, truncated: result.truncated ?? false });
      return result;
    },

    async run(call, ctx) {
      return this.execute(await this.plan(call), ctx);
    },
  };
}
