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
