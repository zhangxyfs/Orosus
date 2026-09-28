import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { writeSectionKey } from "@orosus/core";

/** 模块启停行级写（2023-09-23 模块热插拔；m4-8 T3 收口统一写口）：行级逻辑活在 core/config/write.ts
 *  （三份复制并一份），本函数 = writeSectionKey 薄壳——filePath 语义 = 直写目标（路由由调用方做：
 *  模块节经 sectionPath → modules.d/<名>.toml，见 main.ts moduleConfigFileFor）。
 *  行级而非 stringify：保注释与键序（/model 写盘同教训）。 */
export function setModuleEnabledInConfig(name: string, enabled: boolean, filePath = join(orosusHome(), "config.toml")): void {
  writeSectionKey(filePath, name, "enabled", enabled);
}
