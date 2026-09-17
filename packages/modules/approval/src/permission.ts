import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { CommandHandler } from "@orosus/contracts/module";
import type { ApprovalRule, PermissionMode } from "./decide.ts";

/** /permission 写回的缺省配置文件（§6.6 平台注记：~/.orosus 经 os.homedir() 解析）。 */
export function defaultConfigFile(): string {
  return join(homedir(), ".orosus", "config.toml");
}

function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>; // BOM 剥离（v17）
}

/** 把 [approval] mode 写回配置（读-改-写全量重写——M2 既定策略，注释移除明示）。
 *  写"生效层"（五轮 P1）：项目层 config 含 [approval] 节时写项目层（否则写用户层）——
 *  分层合并项目层覆盖用户层，写错层 = 切换静默失效。 */
export function persistMode(configPath: string, mode: PermissionMode, projectConfigPath?: string): void {
  const target = projectConfigPath !== undefined && hasApprovalSection(projectConfigPath) ? projectConfigPath : configPath;
  const doc = readToml(target);
  const section = (doc["approval"] as Record<string, unknown> | undefined) ?? {};
  section["mode"] = mode;
  doc["approval"] = section;
  writeFileSync(target, stringify(doc), "utf8");
}

function hasApprovalSection(path: string): boolean {
  return (readToml(path)["approval"] as Record<string, unknown> | undefined) !== undefined;
}

/** /permission 命令（D36/D38，内建别名 /permission → approval__permission）：
 *  模式菜单（中文，D37 语言约定）→ 运行期闭包 override 即时生效 + 写回 config 持久化。 */
export function createPermissionHandler(opts: {
  current(): PermissionMode;
  apply(next: PermissionMode): void;
  rules(): ApprovalRule[];
  configPath: string;
  projectConfigPath?: string; // 生效层判定（五轮 P1）：项目层含 [approval] 节时写项目层
}): CommandHandler {
  return async (_args, ui) => {
    const top = await ui.choose("权限管理", ["切换权限模式", "查看规则清单", "取消"]);
    if (top === "取消") return "已取消";
    if (top === "查看规则清单") {
      const rules = opts.rules();
      const lines = rules.length > 0
        ? rules.map((r) => `  ${r.effect.padEnd(5)} ${r.tool}`)
        : ["  （无——在 config.toml 的 [approval] rules 中配置 allow/ask/deny，优先于模式基线）"];
      return `用户规则（优先于模式基线，配置序首条命中即止）：\n${lines.join("\n")}`;
    }
    const modes: { label: string; value: PermissionMode }[] = [
      { label: "始终询问（ask-always）", value: "ask-always" },
      { label: "需要时询问（ask-risky，默认）", value: "ask-risky" },
      { label: "从不询问（危险命令仍确认）", value: "never" }, // 五轮 UX 修正：与 D36 修订后的 never 语义一致
    ];
    const picked = await ui.choose(`当前权限模式：${opts.current()}——选择新模式`, modes.map((m) => m.label));
    const next = modes.find((m) => m.label === picked)?.value;
    if (next === undefined) return "已取消";
    opts.apply(next);
    try {
      persistMode(opts.configPath, next, opts.projectConfigPath);
    } catch (err) {
      return `权限模式已切换：${next}（本会话即时生效）——但持久化失败：${err instanceof Error ? err.message : String(err)}`;
    }
    return `权限模式已切换：${next}（本会话即时生效；已写入 ${opts.configPath}，配置全量重写、注释已移除）`;
  };
}
