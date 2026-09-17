import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import type { CommandUi } from "@orosus/contracts/module";

/** 首启检测（M3 T10 补空白）：model 未配置或指向不可用 provider 槽 → 需要引导。
 *  keyless 但激活的槽（openai 的 apiKey 可选）不算"未配置"——其密钥错误在调用期带内 401 明示。 */
export function needsProviderSetup(opts: { model: string | undefined; providers: string[] }): boolean {
  const model = opts.model?.trim();
  if (model === undefined || model === "") return true;
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : model; // 裸名 = provider 本身（D32）
  return !opts.providers.includes(provider);
}

/** 读取配置文件声明的 model（user → project，后者胜——§6.6 分层在 CLI 侧的只读镜像）。
 *  坏 TOML / 无文件 → undefined（引导降级为"未配置"，不因手改坏文件炸首启）。 */
export function readConfigModel(userFile: string, projectFile: string): string | undefined {
  const read = (f: string): unknown => {
    if (!existsSync(f)) return undefined;
    try {
      return (parse(readFileSync(f, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>)["model"];
    } catch {
      return undefined;
    }
  };
  const v = read(projectFile) ?? read(userFile);
  return typeof v === "string" ? v : undefined;
}

/** 首启引导流：确认 → 复用 /provider 向导（D37"只输 apiKey 即用"同一闭环）。
 *  返回向导输出（或跳过提示）；配置是否生效由调用方 reload 后复检。 */
export async function runOnboarding(
  h: { prompt(text: string): Promise<string | undefined> },
  ui: CommandUi,
): Promise<string> {
  const go = await ui.confirm("尚未配置任何模型提供商——现在配置吗？（进入 /provider 向导：选平台 → 粘贴 apiKey 即用）");
  if (!go) return "已跳过——随时输入 /provider 配置（或参照 docs/developers.md 手写 config.toml）";
  return (await h.prompt("/provider")) ?? "（/provider 不可用——请确认 provider-custom 模块已启用）";
}
