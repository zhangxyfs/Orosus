import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { orosusHome } from "@orosus/contracts/home";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { CommandHandler } from "@orosus/contracts/module";
import type { ApprovalRule, PermissionMode } from "./decide.ts";

/** /permission 写回的缺省配置文件（§6.6 平台注记：~/.orosus 经 os.homedir() 解析）。 */
export function defaultConfigFile(): string {
  return join(orosusHome(), "config.toml");
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

/** 「始终允许（写规则落盘）」规则持久化（M4-2 T9）：[approval] rules 追加 allow 条目（去重）。
 *  写生效层同 persistMode：项目层含 [approval] 节写项目层，否则用户层。 */
export function persistAllowRule(configPath: string, tool: string, projectConfigPath?: string): void {
  const target = projectConfigPath !== undefined && hasApprovalSection(projectConfigPath) ? projectConfigPath : configPath;
  const doc = readToml(target);
  const section = (doc["approval"] as Record<string, unknown> | undefined) ?? {};
  const rules = Array.isArray(section["rules"]) ? [...(section["rules"] as { effect?: string; tool?: string }[])] : [];
  if (!rules.some((r) => r.tool === tool)) rules.push({ effect: "allow", tool });
  section["rules"] = rules;
  doc["approval"] = section;
  writeFileSync(target, stringify(doc), "utf8");
}

/** /permission 命令（D36/D38，内建别名 /permission → approval__permission；用户走查 2026-09-19 重构）：
 *  无参 = 直达三档模式菜单（原「切换/查看/取消」顶级菜单退役——默认路径就是切档）；
 *  `rules` 子参数 = 规则清单文本直出（能力保留、不占默认路径）。
 *  运行期闭包 override 即时生效 + 写回生效层持久化。 */
export function createPermissionHandler(opts: {
  current(): PermissionMode;
  apply(next: PermissionMode): void;
  rules(): ApprovalRule[];
  configPath: string;
  projectConfigPath?: string; // 生效层判定（五轮 P1）：项目层含 [approval] 节时写项目层
}): CommandHandler {
  return async (args, ui) => {
    if (args.trim() === "rules") {
      const rules = opts.rules();
      const lines = rules.length > 0
        ? rules.map((r) => `  ${r.effect.padEnd(5)} ${r.tool}`)
        : ["  （无——审批面板选「始终允许（写规则落盘）」自动累积，或在 config.toml 的 [approval] rules 手写）"];
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
    return `权限模式已切换：${next}`; // 瘦身（2026-09-20 用户实测：只报切到什么）；失败分支保留细节
  };
}

/** /yolo 命令（用户走查 2026-09-19）：一键切「从不询问」（never——危险命令仍确认，D36 修订语义）。
 *  零交互直达：无菜单无确认——就是「别问了」的显式表达。 */
export function createYoloHandler(opts: {
  apply(next: PermissionMode): void;
  configPath: string;
  projectConfigPath?: string;
}): CommandHandler {
  return async () => {
    opts.apply("never");
    try {
      persistMode(opts.configPath, "never", opts.projectConfigPath);
    } catch (err) {
      return `权限模式已切换：never（/yolo，本会话即时生效）——但持久化失败：${err instanceof Error ? err.message : String(err)}`;
    }
    return "权限模式已切换：never"; // 瘦身同上——never 语义（危险命令仍确认）在 /permission 菜单项内已注明
  };
}
