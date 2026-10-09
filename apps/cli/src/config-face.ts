import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { loadConfig, sectionPath, modelsDevCacheFile, resolveContextWindow } from "@orosus/core"; // 读配置单一事实源(m4-8 T2.5)/路由(T3)/窗口兜底链(2026-09-29)
import type { Harness } from "@orosus/core";
import { BUILTIN_MODULES } from "./builtins.ts";

/** 模块节配置路由（m4-8 T3）：模块节 → modules.d/<名>.toml（sectionPath 负责建目录与带节头文件）；
 *  留守节 → config.toml。isModule = 内置 ∪ 当前图在册（audit 含第三方）。含 source 的模块节若被
 *  写 enabled 到 modules.d，与 config.toml 里的 [名] 节由加载层 CH-07 深合并兜底合体（§3.2）。
 *  m5-split-main T2：自 main.ts 搬入，h 经参数注入（D2）。 */
export const moduleConfigFileFor = (name: string, h: Harness): string =>
  sectionPath(name, {
    userConfig: join(orosusHome(), "config.toml"),
    modulesDir: join(orosusHome(), "modules.d"),
    isModule: (n) => BUILTIN_MODULES.some((m) => m.name === n) || h.graph().audit().some((a) => a.name === n),
  });

/** 配置面读数（m4-8 T2.5 收口 loadConfig；2026-09-29 修空参——此前 loadConfig({}) 一层文件都没读：
 *  contextWindow 恒落 200k 硬编码、[approval]/[tui] 盘上值恒不可达）。窗口链 = config 显式值 >
 *  models-dev 目录兜底（resolveContextWindow）> 200k 显示缺省。env 层语义对齐(方案空白 7)不变。 */
export function configFacePaths(): { userFile: string; projectFile: string; userModulesDir: string; projectModulesDir: string } {
	return {
		userFile: join(orosusHome(), "config.toml"),
		projectFile: join(process.cwd(), ".orosus", "config.toml"),
		userModulesDir: join(orosusHome(), "modules.d"),
		projectModulesDir: join(process.cwd(), ".orosus", "modules.d"),
	};
}
export const configFace = (): { contextWindow: number; approvalMode: string } => {
	const cfg = loadConfig(configFacePaths());
	// sections 透传（2026-10-08 修）：裸槽名经 [provider-custom] defaultModel 解出真模型再查 models-dev 表
	const cw = resolveContextWindow(cfg.core, { catalogFile: modelsDevCacheFile(orosusHome()), sections: cfg.sections });
	const mode = (cfg.sections.get("approval") as { mode?: unknown } | undefined)?.mode;
	return {
		contextWindow: typeof cw === "number" ? cw : 200000,
		approvalMode: typeof mode === "string" ? mode : "ask-risky",
	};
};

/** [tui] 三键读数（m4-8 T2.5 收口 loadConfig——modules.d 自动生效；2026-09-29 补文件路径，此前空参恒 undefined）。
 *  分层对齐(方案空白 9):旧散读是「用户层优先」,收口统一为 §6.6 权威「项目压用户」——tui 键
 *  几乎总在用户层,真机感知面近零;登记为有意对齐。function 声明——main.ts 顶层求值期要用。 */
export function configFaceTuiLatex(): boolean | undefined {
	const v = (loadConfig(configFacePaths()).sections.get("tui") as { latex?: unknown } | undefined)?.latex;
	return typeof v === "boolean" ? v : undefined;
}

export function configFaceTuiBell(): unknown {
	return (loadConfig(configFacePaths()).sections.get("tui") as { bell?: unknown } | undefined)?.bell;
}

export function configFaceTui(): string | undefined {
	const v = (loadConfig(configFacePaths()).sections.get("tui") as { mode?: unknown } | undefined)?.mode;
	return typeof v === "string" ? v : undefined;
}

/** 子代理配置文件（M4.5 T12）：用户层 config.toml——[tool-subagent] 节 model/approvalMode 两键。 */
export const subagentConfigFile = (): string => join(orosusHome(), "config.toml");
/** 模型槽清单（子代理模型菜单数据源——/model 同源换写盘目标）。m5-split-main T2：h 经参数注入（D2）。 */
export const modelSlotList = (h: Harness): { name: string; defaultModel?: string; listModels?: () => Promise<string[]> }[] =>
	h.graph().services.listProviders().map((x) => ({
		name: x.name,
		...(x.defaultModel !== undefined ? { defaultModel: x.defaultModel } : {}),
		...(h.graph().services.provider(x.name)?.listModels !== undefined ? { listModels: h.graph().services.provider(x.name)!.listModels! } : {}),
	}));
