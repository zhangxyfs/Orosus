import { orosusHome } from "@orosus/contracts/home";
import { join } from "node:path";
import type { CommandUi } from "@orosus/contracts/module";
import type { Harness } from "@orosus/core";
import { needsProviderSetup, readConfigModel, runOnboarding } from "./onboarding.ts";
import { BRAND_NO_KEY } from "./banner.ts";

/** 启动期引导编排（模型发现 T0——M3 T9 欠账接线）：TTY 且需要配置 → 确认 → /provider 向导 → /reload → 复检回显。
 *  抽取为可测面（main.ts 顶层不可 import——render.ts 同款先例）；非交互跳过（既有语义）。
 *  只在首会话调用——/new、/fork 换出的会话不触发（M3 T9 定案）。 */
export async function startupGate(opts: {
  h: Harness;
  ui: CommandUi;
  /** 读当前 config 声明的 model（真实实现 readConfigModel；测试注入可变值以覆盖"向导写入后复检转绿"） */
  readModel: () => string | undefined;
  isTty: boolean;
}): Promise<string | undefined> {
  if (!opts.isTty) return undefined;
  const slotNames = () => opts.h.graph().services.listProviders().map((p) => p.name);
  if (!needsProviderSetup({ model: opts.readModel(), providers: slotNames() })) return undefined;
  // 品牌降级名单（M4-2 T16/B8 宿主层编排——模块不写他人 config，铁律 1）：向导确认文案点名品牌
  const degradedBrands = opts.h.graph().audit()
    .filter((a) => a.state === "failed" && a.name.startsWith("provider-") && BRAND_NO_KEY.test(a.failReason ?? ""))
    .map((a) => a.name.replace(/^provider-/, ""));
  const wizardOut = await runOnboarding(opts.h, opts.ui, degradedBrands);
  await opts.h.prompt("/reload"); // 向导写的是 config 文件——重载生效
  // 复检回显（不阻断——用户可能中途取消）
  const ok = !needsProviderSetup({ model: opts.readModel(), providers: slotNames() });
  return `${wizardOut}\n${ok ? "✓ 配置已生效" : "⚠ 复检未通过——model 仍未配置（可 /model 选择，或手改 config.toml 后 /reload）"}`;
}

/** 真实 readModel：用户层 → 项目层（§6.6 分层的只读镜像，onboarding.readConfigModel 同源）。 */
export function realReadModel(cwd: string): () => string | undefined {
  return () => readConfigModel(join(orosusHome(), "config.toml"), join(cwd, ".orosus", "config.toml"));
}
