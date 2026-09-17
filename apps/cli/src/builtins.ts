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

/** CLI 内置模块全家福（§8.7 builtin 层，M2 收敛）。
 *  M3 口子：审批（approval）与会话压缩（compaction）模块随 M3 方案审查后加入此清单。 */
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
];
