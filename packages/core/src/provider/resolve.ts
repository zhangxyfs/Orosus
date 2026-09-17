/** 核心顶层 model key 格式（§6.6，D32）：<provider>/<model> 或裸 <provider>（裸名时核心向该槽查 defaultModel）。 */
export function parseModel(model: string): { provider: string; model?: string } {
  const i = model.indexOf("/");
  if (i < 0) {
    if (model.trim() === "") throw new Error(`model 格式须为 <provider>/<model> 或裸 <provider>，得到："${model}"`);
    return { provider: model };
  }
  if (i === 0 || i === model.length - 1) {
    throw new Error(`model 格式须为 <provider>/<model> 或裸 <provider>，得到："${model}"`);
  }
  return { provider: model.slice(0, i), model: model.slice(i + 1) };
}
