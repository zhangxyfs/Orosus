import { z } from "zod";
import { defineModule, type SubagentOutcome, type SubagentPort, type SubagentSpawnRequest } from "@orosus/contracts/module";
import { orosusHome } from "@orosus/contracts/home";
import { defineTool, type Tool } from "@orosus/contracts/tool";
import { BUILTIN_ROLES, resolveRole } from "./builtin-roles.ts";
import { defaultRoleDirs, loadRoles, type RoleDirs, type RoleFile } from "./roles.ts";

export { BUILTIN_ROLES, resolveRole } from "./builtin-roles.ts";
export { defaultRoleDirs, loadRoles, parseRoleFile, type RoleDirs, type RoleFile } from "./roles.ts";

/** 一张任务清单的最多条数（决策 5——内核并发上限 8 与清单上限 128 是两件事：128 是申报、8 是同时跑）。 */
export const SUBAGENT_LIST_MAX = 128;

/** 派活工具说明（决策 5 / 设计空白权威文本——三处引用同一份，勿散抄）。v2（m4-6 T1）：前后台判据句（kimi 定式）+ 后台三禁（qwen 收窄到我们机制）。 */
const SPAWN_GUIDANCE = "派出独立上下文的子代理，只返回最终结论。任务书自包含。相互独立的任务并行派出：一次至少 2 个、最多 8 个，按任务量自行判断。要写文件的子代理必须报备 writePaths。\n前台还是后台：下一步需要它的结论才能继续就不传 background（前台，结论当场返回）；它跑着期间你另有独立工作可做才传 background。不要后台发起后立刻干等它——轮询任务列表、休眠、反复查进度都算；需要结论就直接前台。\n后台三禁：后台子代理跑完，结论以系统送回行自动送回对话——送回行没到就是还在跑；不要自己预测或编造结论，不要另派一个子代理重跑同一任务，不要轮询任务列表等进度。";

const STATUS_TEXT: Record<SubagentOutcome["status"], string> = { completed: "完成", failed: "失败" };

/** 单条结论的行格式（决策 15：状态 + 编号 + 轮数 + 结论 + 错误摘要）。 */
const fmtOutcome = (o: SubagentOutcome): string => {
  // 截断收尾标注（双保险丝批 2026-09-27）：不是失败——撞限/超时交卷的结论照送，标注给父代理拆任务的依据
  const capNote = o.truncated === "max_turns"
    ? `（已达轮数上限——强制收尾轮交卷，未完成部分见结论）`
    : o.truncated === "inactivity" ? `（不活动超时收尾——结论为最后回复）`
    : o.truncated === "total_timeout" ? `（总时长超时收尾——结论为最后回复）` : "";
  const head = `- ${o.id} · ${STATUS_TEXT[o.status]} · ${o.turns} 轮${capNote}`;
  // 越界回执与 bash 备查（决策 24⑤——列进结果报告，模型与用户都看得见）
  const receipt: string[] = [];
  if (o.outOfBounds !== undefined && o.outOfBounds.length > 0) {
    receipt.push(`越界回执（实际写过/试图写、不在报备内——宿主记账）：${o.outOfBounds.join("、")}`);
  }
  if (o.bashCommands !== undefined && o.bashCommands.length > 0) {
    receipt.push(`bash 命令备查（实际写路径不可还原）：${o.bashCommands.map((c) => c.slice(0, 80)).join(" | ")}`);
  }
  const receiptText = receipt.length > 0 ? `\n${receipt.join("\n")}` : "";
  if (o.status === "completed") return `${head}\n结论：${o.conclusion}${receiptText}`;
  const tail = o.conclusion !== "" ? `\n最后回复：${o.conclusion}` : "";
  return `${head}\n错误：${o.error ?? "未知"}${tail}${receiptText}`;
};

/** 批量三校验（决策 18）：任务书必含 {{item}}；展开互异；清单至少 2 条（上限 128 由 schema .max 拦）。 */
const expandBatch = (prompt: string, items: string[]): { ok: true; prompts: string[] } | { ok: false; error: string } => {
  if (!prompt.includes("{{item}}")) return { ok: false, error: `批量派活的任务书必须含 {{item}} 占位符（当前任务书没有——每条单子按条目名展开）` };
  if (items.length < 2) return { ok: false, error: `批量清单至少 2 条（当前 ${items.length} 条）——单发不要给 items` };
  if (new Set(items).size !== items.length) {
    const dup = items.find((i, idx) => items.indexOf(i) !== idx)!;
    return { ok: false, error: `清单条目须互异（"${dup}" 重复——展开后的任务书会一模一样）` };
  }
  return { ok: true, prompts: items.map((i) => prompt.split("{{item}}").join(i)) };
};

/** 工种目录组工厂（config 覆盖根——测试密封注入 tmp；缺省 cwd / orosusHome）。 */
type DirsOf = () => RoleDirs;

/** 解析工种名 → RoleFile（文件目录胜 → 内置表）；未知名带可用清单报错。 */
const resolveRoleOrError = (name: string | undefined, dirsOf: DirsOf): { ok: true; role: RoleFile } | { ok: false; error: string } => {
  if (name === undefined) return { ok: true, role: BUILTIN_ROLES.find((r) => r.name === "general")! }; // 缺省 = 通用写型（T4）
  const { roles, warnings } = loadRoles(dirsOf());
  const role = resolveRole(name, roles);
  if (role !== undefined) return { ok: true, role };
  const available = [...new Set([...roles.keys(), ...BUILTIN_ROLES.map((r) => r.name)])].sort().join("、");
  const warnTail = warnings.length > 0 ? `（另有 ${warnings.length} 个工种文件解析失败——详情见诊断日志）` : "";
  return { ok: false, error: `未知工种 "${name}"——可用：${available}${warnTail}` };
};

/** 三工具族（决策 1/16：模块全名前缀；派活/管理工具本身免审批——子代理自己调的工具照常审批）。 */
export function subagentTools(port: SubagentPort, dirsOf: DirsOf, log?: (code: string, msg: string, data?: Record<string, unknown>) => void): Tool[] {
  return [
    defineTool({
      name: "tool-subagent__spawn",
      description: SPAWN_GUIDANCE,
      parameters: z.object({
        // MV-07：describe 承诺的「≤60 字符」落进校验层（原仅文案无 .max，超限静默通过撑长状态行/送回行）。
        // 契约层 SubagentSpawnRequest.label 是「建议」级——本工具面从建议升格为硬界，带内拒话术指路压缩
        description: z.string().min(1).max(60, { message: "简述超过 60 字符上限——它是状态行/任务列表/送回行的显示名，压缩到一句话（任务细节写进 prompt）" })
          .describe("简述（≤60 字符——状态行 / 任务列表 / 送回行的显示名）"),
        prompt: z.string().min(1).describe("任务书——自包含（子代理看不到本对话，除非 forkFrom）。批量时每条按 {{item}} 展开"),
        items: z.array(z.string().min(1)).max(SUBAGENT_LIST_MAX).optional().describe(`批量清单（2-${SUBAGENT_LIST_MAX} 条、条目互异；任务书须含 {{item}}）`),
        role: z.string().optional().describe("工种名：research（只读调研）/ general（通用，缺省）/ 工种文件自定义名"),
        background: z.boolean().optional().describe("true = 后台跑：立即返回编号，跑完结论自动送回对话——仅当你另有独立工作可做时用；需要结论才能继续就别传（前台当场返回）"),
        forkFrom: z.boolean().optional().describe("true = 带上主对话聊天记录到当前为止（「照上面聊的做 X」）"),
        writePaths: z.array(z.string().min(1)).optional().describe("要写文件的子代理必须报备的写路径（相对工作目录；目录含其下一切）——给了则以本参数为准（压过工种预声明）"),
      }),
      resolveExecution: (input) => {
        const args = input as {
          description: string; prompt: string; items?: string[]; role?: string;
          background?: boolean; forkFrom?: boolean; writePaths?: string[];
        };
        return Promise.resolve({
          accesses: [],            // 派活本身不碰资源（免审批——决策 16；子代理自己调的工具照常走审批）
          approvalRule: "tool-subagent__spawn",
          execute: (tc) => runSpawn(port, dirsOf, args, tc.signal, log),
        });
      },
    }),
    defineTool({
      name: "tool-subagent__tasks",
      description: "List current sub-agents (id, depth, parent, label, status, turns) — foreground and background, all in one roster. Background conclusions are delivered automatically on completion — do NOT poll this tool to wait; call only when you truly need the roster snapshot.",
      parameters: z.object({}),
      resolveExecution: () => Promise.resolve({
        accesses: [],
        approvalRule: "tool-subagent__tasks",
        execute: async () => {
          const list = port.list();
          if (list.length === 0) return { output: "（暂无在册子代理——派出后这里会列出）", isError: false };
          const lines = list.map((a) => {
            const rel = a.parentId !== undefined ? `${a.parentId} - ${a.id}` : a.id; // 决策 21 亲缘格式同款（父 - 孙）
            return `- ${rel} · ${a.label} · ${a.status}${a.pendingApproval !== undefined ? " · 等审批" : ""} · ${a.turns} 轮${a.background ? " · 后台" : ""}`;
          });
          return { output: lines.join("\n"), isError: false };
        },
      }),
    }),
    defineTool({
      name: "tool-subagent__stop",
      description: "Stop one sub-agent by id (stopped agents end as failed; pending approvals auto-deny).",
      parameters: z.object({ id: z.string().min(1).describe("8 位编号（tool-subagent__tasks 可查）") }),
      resolveExecution: (input) => {
        const { id } = input as { id: string };
        return Promise.resolve({
          accesses: [],
          approvalRule: "tool-subagent__stop",
          execute: () => Promise.resolve(
            port.stop(id)
              ? { output: `已停止 ${id}（按失败收场，挂起审批已自动回绝）`, isError: false }
              : { output: `无此编号或已结束：${id}`, isError: true },
          ),
        });
      },
    }),
  ];
}

/** spawn 执行体：工种解析 → 批量校验展开 → 并行派单 → 决策 15 格式打包。 */
async function runSpawn(
  port: SubagentPort,
  dirsOf: DirsOf,
  args: { description: string; prompt: string; items?: string[]; role?: string; background?: boolean; forkFrom?: boolean; writePaths?: string[] },
  signal: AbortSignal | undefined,
  log?: (code: string, msg: string, data?: Record<string, unknown>) => void,
): Promise<{ output: string; isError: boolean }> {
  const role = resolveRoleOrError(args.role, dirsOf);
  if (!role.ok) return { output: role.error, isError: true };

  let prompts: string[];
  if (args.items !== undefined) {
    const batch = expandBatch(args.prompt, args.items);
    if (!batch.ok) return { output: batch.error, isError: true };
    prompts = batch.prompts;
  } else {
    prompts = [args.prompt];
  }

  const makeReq = (i: number): SubagentSpawnRequest => ({
    label: args.items !== undefined ? `${args.description}：${args.items[i]}` : args.description,
    prompt: prompts[i]!,
    rolePrompt: role.role.prompt,
    roleName: role.role.name,
    ...(role.role.tools !== undefined ? { allowedTools: role.role.tools } : {}),
    ...(role.role.disallowedTools !== undefined ? { disallowedTools: role.role.disallowedTools } : {}),
    ...(role.role.model !== undefined ? { model: role.role.model } : {}),
    ...(role.role.maxTurns !== undefined ? { maxTurns: role.role.maxTurns } : {}),
    ...(args.writePaths !== undefined
      ? { writePaths: args.writePaths }
      : role.role.writePaths !== undefined ? { writePaths: role.role.writePaths } : {}), // spawn 显式给的压过工种预声明
    ...(args.forkFrom === true ? { forkFrom: true } : {}),
    ...(args.background === true ? { background: true } : {}),
  });

  try {
    const outcomes = await Promise.all(prompts.map((_, i) => port.spawn(makeReq(i), signal !== undefined ? { signal } : undefined)));
    const done = outcomes.filter((o): o is SubagentOutcome => "status" in o) as SubagentOutcome[];
    const tickets = outcomes.filter((o): o is { id: string } => !("status" in o));
    const parts: string[] = [];
    if (done.length > 0) {
      const okCount = done.filter((o) => o.status === "completed").length;
      parts.push(`子代理完成（${okCount}/${done.length}）：\n${done.map(fmtOutcome).join("\n")}`);
    }
    if (tickets.length > 0) {
      parts.push(`后台已入册（${tickets.length} 个，跑完自动送回）：${tickets.map((t) => t.id).join("、")}。期间去做别的独立工作——送回行没到 = 还在跑：不要轮询、不要预测结论、不要重派替身。`);
    }
    return { output: parts.join("\n\n"), isError: done.length > 0 && done.every((o) => o.status === "failed") };
  } catch (err) {
    log?.("tool-subagent.spawn-failed", "派活失败", { error: String(err) });
    return { output: `派活失败：${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

const configSchema = z.object({
  /** 以下三键由内核子代理缝消费（模型三来源 / 审批模式 / 轮数上限解析）——模块 schema 在此只为通过配置校验。 */
  model: z.string().optional(),
  approvalMode: z.enum(["auto", "ask"]).optional(),
  /** 轮数上限（双保险丝批 2026-09-27）：-1 = 不限（仅时长兜底）；正整数 [1, 200]。解析序 本键 > 工种 > 默认 100。 */
  maxTurns: z.number().int().refine((v) => v === -1 || (v >= 1 && v <= 200), "maxTurns 须为 -1（不限）或 1-200").optional(),
  /** 不活动超时毫秒（ZCode 定式）：-1 = 关；缺省 600_000。 */
  inactivityTimeoutMs: z.number().int().refine((v) => v === -1 || v >= 1000, "inactivityTimeoutMs 须为 -1（关）或 ≥1000").optional(),
  /** 总时长兜底毫秒（kimi 定式）：-1 = 关；缺省 7_200_000（2 小时）。 */
  totalTimeoutMs: z.number().int().refine((v) => v === -1 || v >= 1000, "totalTimeoutMs 须为 -1（关）或 ≥1000").optional(),
  /** 测试密封 / 高级覆盖：工种目录的两根（缺省 = 进程 cwd / orosusHome）。 */
  projectRoot: z.string().optional(),
  userRoot: z.string().optional(),
});

export default defineModule({
  name: "tool-subagent",
  version: "0.1.0",
  description: "子代理派活工具族——独立上下文帮手（spawn 派活 / tasks 在册 / stop 停单个）",
  api: 1,
  mounts: ["contribute:tool", "subagent"],
  config: configSchema,
  activate(ctx) {
    const port = ctx.subagent;
    if (port === undefined) return; // 老宿主无子代理缝——判空降级，不贡献工具
    const cfg = ctx.config as z.infer<typeof configSchema>;
    const dirsOf = () => defaultRoleDirs(cfg.projectRoot ?? process.cwd(), cfg.userRoot ?? orosusHome());
    for (const t of subagentTools(port, dirsOf, (code, msg, data) => ctx.log.warn(code, msg, data))) ctx.contribute.tool(t);
  },
});
