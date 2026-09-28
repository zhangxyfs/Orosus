/** 核心顶层 model key 格式（§6.6，D32）：<provider>/<model> 或裸 <provider>（裸名时核心向该槽查 defaultModel）。 */
export function parseModel(model: string): { provider: string; model?: string } {
  // CL-06（2026-09-28 code review P3）：解析前后 trim——空白垫层（" glm"、"a / b"）旧实现原样透传，
  // 槽名比对永不命中而报「不可见」错误；空段判据同步改用 trim 后各段（" /x" 类不再漏网）
  const s = model.trim();
  const i = s.indexOf("/");
  if (i < 0) {
    if (s === "") throw new Error(`model 格式须为 <provider>/<model> 或裸 <provider>，得到："${model}"`);
    return { provider: s };
  }
  const provider = s.slice(0, i).trim();
  const modelName = s.slice(i + 1).trim();
  if (provider === "" || modelName === "") {
    throw new Error(`model 格式须为 <provider>/<model> 或裸 <provider>，得到："${model}"`);
  }
  return { provider, model: modelName };
}
