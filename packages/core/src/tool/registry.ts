import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Disposer, Logger } from "@orosus/contracts/module";
import { Access, type Tool, type ToolExecution, type ToolInfo, type ToolResult } from "@orosus/contracts/tool";
import type { ToolSpec } from "@orosus/contracts/provider";
import { CORE_POINTS, type EventBus } from "../kernel/bus.ts";
import { createLogger, type DiagSink } from "../diag/logger.ts";

/** 单条工具输出上限（字节按 length 近似），超出截断 + 溢写 spill（§6.3）。 */
export const OUTPUT_LIMIT = 32768;
/** 头尾双保留配比（M4-2.5 T1，3:1）：头保上下文、尾保报错摘要——两段相加 = OUTPUT_LIMIT。 */
export const HEAD_KEEP = 24576;
export const TAIL_KEEP = 8192;

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
  /** ToolSearch 机制面（M4-3 T4）：置 reveal（已加载集合随实例存活——压缩后不清，SW-11）。 */
  revealTools(names: string[]): void;
  /** 机制总开关（SW-26：tool-search 启用才置位——关态整门不启，deferred 标记不生效、specs 零过滤）。 */
  setDeferredEnabled(on: boolean): void;
  /** ctx.tools.list 数据源：目录条目（不给 schema）。 */
  toolInfos(opts?: { deferredOnly?: boolean }): ToolInfo[];
}

/**
 * 两阶段执行管线（§6.3，D40 拆分）：
 * plan = resolveExecution（声明）+ 参数校验（失败短路为带内结果）；execute = tool/pre-execute waterfall（审批）
 * → execute → 归一（截断/spill）。run 为合成口（M1 语义不变）。loop 消费 plan/execute 做 §6.3 并发分组。
 * fail-closed 默认值：accesses 缺省 = kind:"all"；approvalRule 缺省 = 需要审批。
 */
export function createToolRegistry(opts: { bus: EventBus; sink: DiagSink; spillDir: string }): ToolRegistry {
  const tools: { tool: Tool; owner: string; tombstoned?: boolean }[] = [];
  // ToolSearch 机制态（M4-3 T4）：deferredEnabled = 总开关（SW-26 关态整门不启的前提位）；
  // revealed = 已加载集合——随 registry 实例存活，压缩/会话裁剪不清（SW-11，cc-haha 同款，kimi 清空是反例）
  let deferredEnabled = false;
  const revealed = new Set<string>();
  /** 藏 schema 判定（前提 = 机制启用；墓碑位不动——§5.5 tools 数组字节稳定优先于隐藏）。 */
  const hidden = (t: { tool: Tool; tombstoned?: boolean }): boolean =>
    deferredEnabled && t.tool.deferred === true && !revealed.has(t.tool.name) && t.tombstoned !== true;

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
      // ToolSearch 过滤（M4-3 T4）：机制启用时藏 deferred 未 reveal——关态/无人标 deferred 时逐字节不变（零差异基线钉）
      return tools.filter((t) => !hidden(t)).map(({ tool }) => ({
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
      // 按需加载拦截（M4-3 T4，kimi toolSelectService.ts:333-338 话术同族）：模型点名了 deferred 未 reveal
      // 的工具 → 带内指路 meta 工具（体验增强非正确性依赖——幻觉名（未注册）已由上方「未知工具」兜住）
      if (deferredEnabled && entry.tool.deferred === true && !revealed.has(call.name)) {
        return { ok: false, callId: call.id, result: { output: `工具 "${call.name}" 处于按需加载目录中，先调 tool-search__search 加载（搜索即加载，下一轮起可调用）`, isError: true } };
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
        // 头尾双保留 3:1（M4-2.5 T1）：头 24576 保调用上下文、尾 8192 保报错摘要（命令报错常在尾部），
        // 总量不变；中缝提示溢写全文位置。kimi 4:1 同思路，本批略偏头。
        const head = result.output.slice(0, HEAD_KEEP);
        const tail = result.output.slice(-TAIL_KEEP);
        result = {
          ...result,
          output: `${head}\n[…中间截断 ${bytes - HEAD_KEEP - TAIL_KEEP} 字符——全文已溢写 ${path}…]\n${tail}`,
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

    revealTools(names) {
      const known = new Set(tools.map((t) => t.tool.name));
      for (const n of names) if (known.has(n)) revealed.add(n); // 未知名静默跳过（契约口径）
    },

    setDeferredEnabled(on) {
      deferredEnabled = on;
    },

    toolInfos(opts2) {
      return tools
        .filter((t) => t.tombstoned !== true)
        .filter((t) => opts2?.deferredOnly === true ? t.tool.deferred === true : true)
        .map((t) => ({
          name: t.tool.name,
          description: t.tool.description,
          deferred: t.tool.deferred === true,
          ...(t.tool.searchHint !== undefined ? { searchHint: t.tool.searchHint } : {}),
          revealed: revealed.has(t.tool.name),
          owner: t.owner,
        }));
    },
  };
}
