/** 核心顶层 model key 格式：<provider>/<model>（§6.6）。provider 名即适配器注册的 provider:<name>。 */
export function parseModel(model: string): { provider: string; model: string } {
  const i = model.indexOf("/");
  if (i <= 0 || i === model.length - 1) {
    throw new Error(`model 格式须为 <provider>/<model>，得到："${model}"`);
  }
  return { provider: model.slice(0, i), model: model.slice(i + 1) };
}
