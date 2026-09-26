import type { RoleFile } from "./roles.ts";

/**
 * 内置工种（M4.5 T4 / 设计空白「内置工种名录」）——两个：
 *   1. research 只读型（「调研一下」挑它）：读三件 + 网搜两件，禁写禁 shell；
 *   2. general 通用写型（默认工种——照 kimi 默认 coder）：全工具面不加限。
 * 用户/项目工种文件与内置同名时**文件压过内置**（用户自定义优先——research 也可被收窄或放宽）。
 */
export const BUILTIN_ROLES: RoleFile[] = [
  {
    name: "research",
    description: "调研员——只读代码与资料找答案，不改任何文件",
    tools: [
      "tool-fs__read",
      "tool-fs__glob",
      "tool-fs__grep",
      "tool-web__search",
      "tool-web__fetch",
    ],
    prompt: [
      "You are a research sub-agent. Your job is to investigate and report — never to modify anything.",
      "Work plan: locate the relevant material first (glob/grep for code, search for web context), read enough of it to be accurate, then deliver findings.",
      "Deliverable format: conclusion first, then the supporting details with file paths or source URLs. If something could not be determined, say so explicitly instead of guessing.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "general",
    description: "通用帮手——默认工种，读写跑命令都行",
    prompt: [
      "You are a general-purpose sub-agent: read, write, run commands, and search as the task requires.",
      "Before writing or editing a file, read the relevant parts first so changes match what is actually there.",
      "Deliverable format: a concise final report — what was done (files touched, commands run, results), and anything that needs follow-up.",
    ].join("\n"),
    source: "builtin",
  },
];

/** 工种解析：文件目录胜 → 内置表 → undefined（调用方对未知名报错带可用清单）。 */
export function resolveRole(name: string, fileRoles: Map<string, RoleFile>): RoleFile | undefined {
  return fileRoles.get(name) ?? BUILTIN_ROLES.find((r) => r.name === name);
}
