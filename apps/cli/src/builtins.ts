import type { ModuleDefinition } from "@orosus/contracts/module";
import toolFs from "@orosus/tool-fs";
import toolShell from "@orosus/tool-shell";
import toolTodo from "@orosus/tool-todo";
import toolAsk from "@orosus/tool-ask";
import toolWeb from "@orosus/tool-web";
import toolSearch from "@orosus/tool-search";
import toolGoal from "@orosus/tool-goal";
import sessionTree from "@orosus/session-tree";
import providerCustom from "@orosus/provider-custom";
import { mcpDef } from "@orosus/mcp";
import skill from "@orosus/skill";
import approval from "@orosus/approval";
import compaction from "@orosus/compaction";

/** CLI 内置模块全家福（§8.7 builtin 层，M2 收敛）。
 *  approval（T3）与 compaction（T5）已接入；tool-todo（M4-2 T7）任务清单；tool-ask（T8）模型提问。
 *  session-tree（会话树批 T12）：树视图驾驶舱——/session-tree__view 看树跳枝、/session-tree__branch 建枝。
 *  provider 路线归一（2026-09-23 用户拍板删除）：品牌 ×4（anthropic/glm/kimi/deepseek）与 openai 退役——
 *  无界面入口的半成品预设（/provider 向导只写 custom 区），custom + models.dev 目录 + 双协议族翻译层
 *  已全覆盖（官方端点经向导选厂商即得 baseUrl/模型清单）。 */
export const BUILTIN_MODULES: ModuleDefinition[] = [
  toolFs,
  toolShell,
  toolTodo,
  toolAsk,
  toolWeb,
  toolSearch,
  toolGoal,
  sessionTree,
  providerCustom,
  mcpDef,
  skill,
  approval,
  compaction,
];
