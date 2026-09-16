import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Disposer, Logger } from "@orosus/contracts/module";
import { Access, type Tool, type ToolResult } from "@orosus/contracts/tool";
import type { ToolSpec } from "@orosus/contracts/provider";
import { CORE_POINTS, type EventBus } from "../kernel/bus.ts";
import { createLogger, type DiagSink } from "../diag/logger.ts";

/** 单条工具输出上限（字节按 length 近似），超出截断 + 溢写 spill（§6.3）。 */
export const OUTPUT_LIMIT = 32768;

export interface ToolRegistry {
  register(tool: Tool, owner: string): Disposer;
  list(): Tool[];
  specs(): ToolSpec[];
  run(call: { id: string; name: string; args: unknown }, ctx: { signal: AbortSignal }): Promise<ToolResult>;
}

/**
 * 两阶段执行管线（§6.3）：
 * resolveExecution（声明）→ 参数校验 → tool/pre-execute waterfall（审批，M3 前空链即通过）→ execute → 归一。
 * fail-closed 默认值：accesses 缺省 = kind:"all"；approvalRule 缺省 = 需要审批（M1 无消费方，仅作数据携带）。
 * M1 不含并发调度器——调用方（loop）按 call 顺序全串行调用 run（§12）。
 */
export function createToolRegistry(opts: { bus: EventBus; sink: DiagSink; spillDir: string }): ToolRegistry {
  const tools: { tool: Tool; owner: string }[] = [];

  return {
    register(tool, owner) {
      if (!tool.name.startsWith(`${owner}__`)) {
        throw new Error(`工具名 "${tool.name}" 未带 "${owner}__" 前缀（规则 4）`);
      }
      if (tools.some((t) => t.tool.name === tool.name)) {
        throw new Error(`工具重名：${tool.name}`);
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

    specs() {
      return tools.map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
      }));
    },

    async run(call, { signal }) {
      const entry = tools.find((t) => t.tool.name === call.name);
      if (!entry) {
        return { output: `未知工具 "${call.name}"（该工具所属模块可能已降级或未安装）`, isError: true };
      }
      const { tool, owner } = entry;
      const tlog: Logger = createLogger(opts.sink, owner);

      const parsed = tool.parameters.safeParse(call.args);
      if (!parsed.success) {
        return {
          output: `参数校验失败：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          isError: true,
        };
      }

      let execution;
      try {
        execution = await tool.resolveExecution(parsed.data);
      } catch (err) {
        return { output: `resolveExecution 抛错：${String(err)}`, isError: true };
      }
      // fail-closed 默认值（§6.3）：宽松只能由声明显式打开
      const accesses = execution.accesses ?? [Access.all()];
      const approvalRule = execution.approvalRule ?? `${call.name}(需要审批)`; // M1：无消费方的数据

      // 码表纪律（§11.9）：核心码只用 kernel/loop/provider 前缀——工具两阶段归 kernel.tool.*
      tlog.debug("kernel.tool.two-phase", "阶段一完成", { call: call.id, name: call.name, approvalRule, accessKinds: accesses.map((a) => a.kind).join(",") });

      const veto = await opts.bus.waterfall(CORE_POINTS.toolPreExecute, {
        callId: call.id, name: call.name, args: call.args, accesses, approvalRule,
      });
      if (veto) {
        return { output: veto.reason, isError: true, denied: true };
      }

      let result: ToolResult;
      try {
        result = await execution.execute({ callId: call.id, signal, log: tlog });
      } catch (err) {
        result = { output: `工具执行抛错：${String(err)}`, isError: true };
      }

      if (result.output.length > OUTPUT_LIMIT) {
        mkdirSync(opts.spillDir, { recursive: true });
        const path = join(opts.spillDir, `spill-${call.id}.txt`);
        writeFileSync(path, result.output, { mode: 0o600 });
        const bytes = result.output.length;
        result = {
          ...result,
          output: result.output.slice(0, OUTPUT_LIMIT) + `\n…[输出截断，全文 ${bytes}B 已溢写 ${path}]`,
          truncated: true,
          spill: { path, bytes },
        };
      }

      tlog.debug("kernel.tool.result", "执行完成", { call: call.id, isError: result.isError, truncated: result.truncated ?? false });
      return result;
    },
  };
}
