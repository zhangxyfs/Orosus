/** Web/GUI 用户偏好：~/.orosus/gui/gui.toml。配置不进入 modules.d，避免被误认为模块节。 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { writeSectionKey } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import { readBtwModel as readLegacyBtwModel, writeBtwModelKey as writeLegacyBtwModelKey } from "../subagent-settings.ts";
import { guiDir, migrateLegacyGuiFiles } from "./gui-files.ts";

export const GUI_FONT_SCALES = [0.875, 1, 1.125, 1.25, 1.4] as const;
export type GuiMode = "dark" | "light";

export interface GuiPreferences {
  exists: boolean;
  appearanceConfigured: boolean;
  theme: string;
  mode: GuiMode;
  fontScale: number;
  btwModel?: string;
}

export interface GuiPreferencePatch {
  theme?: string;
  mode?: GuiMode;
  fontScale?: number;
  btwModel?: string | null;
}

export const guiConfigFile = (home: string): string => join(guiDir(home), "gui.toml");
const legacyConfigFile = (home: string): string => join(home, "config.toml");
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function readDocument(file: string): Record<string, unknown> {
  try {
    return parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function btwModelFromDocument(doc: Record<string, unknown>): string | undefined {
  const value = asRecord(doc["sideQuestion"])["model"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function btwModelFromGui(home: string): string | undefined {
  return btwModelFromDocument(readDocument(guiConfigFile(home)));
}

export function readGuiPreferences(home = orosusHome()): GuiPreferences {
  const file = guiConfigFile(home);
  const doc = readDocument(file);
  const appearance = asRecord(doc["appearance"]);
  const theme = appearance["theme"];
  const mode = appearance["mode"];
  const fontScale = appearance["fontScale"];
  const btwModel = btwModelFromDocument(doc) ?? readLegacyBtwModel(legacyConfigFile(home));
  return {
    exists: existsSync(file),
    appearanceConfigured: Object.keys(appearance).length > 0,
    theme: typeof theme === "string" && theme.trim() !== "" ? theme.trim() : "连山",
    mode: mode === "light" ? "light" : "dark",
    fontScale: typeof fontScale === "number" && GUI_FONT_SCALES.some((s) => s === fontScale) ? fontScale : 1,
    ...(btwModel !== undefined ? { btwModel } : {}),
  };
}

export function readBtwModel(home = orosusHome()): string | undefined {
  return readGuiPreferences(home).btwModel;
}

/** 部分写入口；btwModel 同步清理旧 config.toml 顶层键，保证后续只有一个事实源。 */
export function writeGuiPreferences(home: string, patch: GuiPreferencePatch): void {
  if (Object.keys(patch).length === 0) return;
  const file = guiConfigFile(home);
  mkdirSync(guiDir(home), { recursive: true });
  if (patch.theme !== undefined) writeSectionKey(file, "appearance", "theme", patch.theme);
  if (patch.mode !== undefined) writeSectionKey(file, "appearance", "mode", patch.mode);
  if (patch.fontScale !== undefined) writeSectionKey(file, "appearance", "fontScale", patch.fontScale);
  if (!hasOwn(patch, "btwModel")) return;
  const next = typeof patch.btwModel === "string" && patch.btwModel.trim() !== "" ? patch.btwModel.trim() : null;
  writeSectionKey(file, "sideQuestion", "model", next);
  if (next === null) {
    writeLegacyBtwModelKey(null, legacyConfigFile(home));
  } else if (btwModelFromGui(home) === next) {
    writeLegacyBtwModelKey(null, legacyConfigFile(home));
  }
}

/** 启动迁移：先搬共享 JSON，再把旧 config.toml 顶层 btwModel 落到 GUI 配置。 */
export function migrateLegacyGuiData(home: string): void {
  migrateLegacyGuiFiles(home);
  const legacy = readLegacyBtwModel(legacyConfigFile(home));
  if (legacy === undefined || btwModelFromGui(home) !== undefined) return;
  const file = guiConfigFile(home);
  mkdirSync(guiDir(home), { recursive: true });
  writeSectionKey(file, "sideQuestion", "model", legacy);
  if (btwModelFromGui(home) === legacy) writeLegacyBtwModelKey(null, legacyConfigFile(home));
}
