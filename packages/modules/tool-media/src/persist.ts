// m5-media F14：[tool-media] visionModel 落盘（tool-web persistToolWebSearch 同款读-改-写全量重写）。
//  写动作归模块（宿主传目标路径——模块不 import core 的 m4-8 T4/C5 纪律）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";

function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>; // BOM 剥离（Windows 写盘默认带 BOM——tool-web 同款注记）
}

/** [tool-media] visionModel 写回（"off" | "auto" | "<槽/模型>"——D12 三态）。 */
export function persistVisionModel(configFile: string, value: string): void {
  const doc = readToml(configFile);
  const section = (doc["tool-media"] as Record<string, unknown> | undefined) ?? {};
  section["visionModel"] = value;
  doc["tool-media"] = section;
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, stringify(doc), "utf8");
}

/** 当前 visionModel 读值（UI 回显用；无文件/无键 = "off" 缺省）。 */
export function readVisionModel(configFile: string): string {
  const section = readToml(configFile)["tool-media"] as Record<string, unknown> | undefined;
  const v = section?.["visionModel"];
  return typeof v === "string" && v !== "" ? v : "off";
}
