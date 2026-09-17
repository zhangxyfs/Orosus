import type { ModuleDefinition } from "@orosus/contracts/module";
import toolFs from "@orosus/tool-fs";
import toolShell from "@orosus/tool-shell";
import anthropic from "@orosus/provider-anthropic";
import glm from "@orosus/provider-glm";
import kimi from "@orosus/provider-kimi";
import deepseek from "@orosus/provider-deepseek";
import openai from "@orosus/provider-openai";
import providerCustom from "@orosus/provider-custom";
import { mcpDef } from "@orosus/mcp";
import skill from "@orosus/skill";
import approval from "@orosus/approval";
import compaction from "@orosus/compaction";

/** CLI 内置模块全家福（§8.7 builtin 层，M2 收敛）。
 *  approval（T3）与 compaction（T5）已接入。 */
export const BUILTIN_MODULES: ModuleDefinition[] = [
  toolFs,
  toolShell,
  anthropic,
  glm,
  kimi,
  deepseek,
  openai,
  providerCustom,
  mcpDef,
  skill,
  approval,
  compaction,
];
