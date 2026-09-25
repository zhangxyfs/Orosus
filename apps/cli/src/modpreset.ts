/** 挂载模式计算（m5 T9/T10 共用）：preset 三态现算 + 极简关闭集——纯函数，供 main.ts 装配与测试。 */

/** 极简保底名单（设计空白 9，决策点 19）：核心本体 + approval 审批护栏 + 当前活跃 provider
 *  （lockReasonFor 三款同款）。providerModule 为空串 = 未配置（名单只含前两款）。 */
export const presetBaseline = (providerModule: string): Set<string> =>
  new Set(["orosus-core", "approval", ...(providerModule !== "" ? [providerModule] : [])]);

/** preset 三态现算（设计空白 17）：启用集 ⊆ 保底名单 → minimal；全启用 → full；其余 → custom。
 *  现算不靠记忆——用户切完极简又手动插拔，「上次切的档」会撒谎，现算永远诚实。 */
export const computeModulePreset = (
  states: readonly { name: string; state: string }[],
  baseline: ReadonlySet<string>,
): "full" | "minimal" | "custom" => {
  const active = states.filter((a) => a.state === "active").map((a) => a.name);
  if (active.every((n) => baseline.has(n))) return "minimal";
  if (states.every((a) => a.state === "active")) return "full";
  return "custom";
};

/** 预设切换计划（m5 T10，设计空白 9/10/16 + 决策点 21 的纯计算面）：写盘清单与语义裁决都在这，
 *  main.ts 只管落盘（逐个 try）+ 统一 reload 一次 + 失败清单带内返回。级联闭包由 main 层在
 *  writes 生成后用 module-deps 展开（闭包计算依赖 depRows，非纯数据）。 */
export interface PresetPlanInput {
	preset: "full" | "minimal";
	/** 当前 active 模块名（audit 现读）。 */
	activeNames: readonly string[];
	/** 极简保底名单（presetBaseline）。 */
	baseline: ReadonlySet<string>;
	/** 极简模式上次关掉的模块（会话内存，undefined = 从未切过极简）。 */
	minimalClosed: ReadonlySet<string> | undefined;
}

export interface PresetPlan {
	writes: { name: string; enable: boolean }[];
	failed: string[];
	note?: "already-minimal" | "nothing-to-restore";
}

export const planModulePreset = (i: PresetPlanInput): PresetPlan => {
	if (i.preset === "minimal") {
		// 关闭集 = 当前启用 − 保底名单；空集 = 已在极简态——幂等：空计划返回（调用方保留原记录不覆盖，
		// 否则第二次 minimal 把记录冲成空、切回完整一个都恢复不了——设计空白 16）
		const targets = i.activeNames.filter((n) => !i.baseline.has(n));
		if (targets.length === 0) return { writes: [], failed: [], note: "already-minimal" };
		return { writes: targets.map((name) => ({ name, enable: false })), failed: [] };
	}
	// full = 恢复极简模式自己关掉的那些（用户手动关过的不是它关的——不在记录里，不会被误开）；
	// 从未切过极简 / 记录为空 = 按配置原样，无操作
	if (i.minimalClosed === undefined || i.minimalClosed.size === 0) return { writes: [], failed: [], note: "nothing-to-restore" };
	return { writes: [...i.minimalClosed].map((name) => ({ name, enable: true })), failed: [] };
};
