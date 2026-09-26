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
      // 档名 + 短解 + 值（2026-09-26 拍板显示名改中文，与全屏菜单同源——F5 十轮⑤ 英文档名由本次取代）
      { label: "每次都询问——每次工具调用都确认", value: "ask-always" },
      { label: "需要时候询问——仅危险操作确认", value: "ask-risky" },
      { label: "从不询问——批准自动处理，就算有问题也是模型自行判断", value: "never" },
    ];
    // 直参直达（F5 用户实测：全屏二级菜单已选定模式，无参菜单再弹一次 = 三级弹窗）——
    // `/permission ask-always` 跳过 choose 直接生效；无参才进菜单
    const direct = args.trim();
    let next: PermissionMode | undefined;
    if (direct !== "") {
      next = modes.find((m) => m.value === direct)?.value;
      if (next === undefined) return `未知权限模式 "${direct}"——合法值：${modes.map((m) => m.value).join(" / ")}`;
    } else {
      const picked = await ui.choose(`当前权限模式：${opts.current()}——选择新模式`, modes.map((m) => m.label));
      next = modes.find((m) => m.label === picked)?.value;
      if (next === undefined) return "已取消";
    }
    opts.apply(next);
    try {
      persistMode(opts.configPath, next, opts.projectConfigPath);
    } catch (err) {
      return `权限模式已切换：${next}（本会话即时生效）——但持久化失败：${err instanceof Error ? err.message : String(err)}`;
    }
    // 静默生效（2026-09-22 用户拍板）：切换成功零输出——面板 chip 即时反映新档，流区落行是噪音；
    // 空串 = 静默的管线约定在 processReplLine（空输出不落流区）。失败分支保留带内详情
    return "";
  };
}

/** /auto 命令（2026-09-22 用户拍板）：一键切「Ask When Needed」（ask-risky——日常默认档）。/yolo 镜像件。 */
export function createAutoHandler(opts: {
  apply(next: PermissionMode): void;
  configPath: string;
  projectConfigPath?: string;
}): CommandHandler {
  return async () => {
    opts.apply("ask-risky");
    try {
      persistMode(opts.configPath, "ask-risky", opts.projectConfigPath);
    } catch (err) {
      return `权限模式已切换：ask-risky（/auto，本会话即时生效）——但持久化失败：${err instanceof Error ? err.message : String(err)}`;
    }
    return ""; // 静默生效（同 /permission /yolo——面板 chip 即时反映）
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
    return ""; // 静默生效（2026-09-22 用户拍板，同 /permission——面板 chip 即时反映；never 语义在 /permission 菜单项内已注明）
  };
}
