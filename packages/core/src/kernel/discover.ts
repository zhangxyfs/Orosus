import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { createLogger, type DiagSink } from "../diag/logger.ts";
import type { ModuleDefinition } from "@orosus/contracts/module";
import { loadExternalModule } from "./loader.ts";

export interface DiscoveredModule {
  def: ModuleDefinition;
  source: "local";
  layer: "user" | "project"; // 信任待遇不同（§8.3/§8.5：项目级须过确认门）
  root: string;              // 模块目录绝对路径
  entry: string;             // 入口文件相对 root 的路径
  entryHash: string;         // 入口内容 sha256（信任登记与 reload diff 用）
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 入口探测结果（T5）：pkg-read = package.json 读不了/解析不了（坏包）；no-entry = 无模块入口（良性）。 */
type ProbeResult = { ok: true; entry: string } | { ok: false; kind: "pkg-read"; detail: string } | { ok: false; kind: "no-entry" };

/** 入口探测（§8.4）：package.json 的 exports["./module"] → main → index.{ts,js}；无 package.json → index.{ts,js}。
 *  T5：package.json 的读取/解析自兜——坏包返回 pkg-read（调用侧 warn 跳过），异常不再穿 createHarness 炸启动。 */
function probeEntry(root: string): ProbeResult {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: {
      orosus?: { module?: boolean };
      exports?: Record<string, string>;
      main?: string;
    };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (err) {
      return { ok: false, kind: "pkg-read", detail: err instanceof Error ? err.message : String(err) };
    }
    if (pkg.orosus?.module !== true) return { ok: false, kind: "no-entry" }; // 有 package.json 但非模块包 → 跳过（warn 由调用侧）
    const fromPkg = pkg.exports?.["./module"] ?? pkg.main;
    if (fromPkg !== undefined && existsSync(join(root, fromPkg))) return { ok: true, entry: fromPkg };
  }
  for (const idx of ["index.ts", "index.js"]) {
    if (existsSync(join(root, idx))) return { ok: true, entry: idx };
  }
  return { ok: false, kind: "no-entry" };
}

async function scanDir(dir: string, layer: "user" | "project", log: ReturnType<typeof createLogger>): Promise<DiscoveredModule[]> {
  const found: DiscoveredModule[] = [];
  if (!existsSync(dir)) return found;
  for (const sub of readdirSync(dir).sort()) {
    const root = join(dir, sub);
    if (!statSync(root).isDirectory()) continue; // 不递归（§8.3）——子目录本身即模块
    const probed = probeEntry(root);
    if (!probed.ok) {
      if (probed.kind === "pkg-read") log.warn("kernel.discover.skip", `目录 ${sub} 的包描述读取失败（package.json：${probed.detail}），跳过`, { module: sub });
      else log.warn("kernel.discover.skip", `目录 ${sub} 无模块入口（无 orosus.module 声明且无 index.{ts,js}），跳过`, { module: sub });
      continue;
    }
    // T5：入口读取 + 哈希自兜（文件被占用/指错形状时 warn 跳过，不再穿 try 外炸启动）
    let entryHash: string;
    try {
      entryHash = sha256(readFileSync(join(root, probed.entry), "utf8"));
    } catch (err) {
      log.warn("kernel.discover.skip", `目录 ${sub} 入口读取失败（${probed.entry}：${err instanceof Error ? err.message : String(err)}），跳过`, { module: sub });
      continue;
    }
    try {
      const def = await loadExternalModule(root, probed.entry);
      found.push({ def, source: "local", layer, root, entry: probed.entry, entryHash });
    } catch (err) {
      log.warn("kernel.discover.fail", `模块 ${sub} 加载失败：${String(err instanceof Error ? err.message : err)}`, { module: sub });
    }
  }
  return found;
}

/** spec 判定（§8.4）：./ ~/ file:// 绝对路径 → 本地目录；npm: 前缀或裸包名 → npm（M3，跳过并 warn）。 */
function resolveSourceSpec(spec: string, configRoot: string): string | undefined {
  if (spec.startsWith("npm:") || !/^[./~]/.test(spec) && !spec.startsWith("file://") && !isAbsolute(spec)) return undefined;
  const expanded = spec.startsWith("~/")
    ? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", spec.slice(2))
    : spec.startsWith("file://")
      ? fileURLToPathSafe(spec)
      : isAbsolute(spec) ? spec : resolve(configRoot, spec);
  return expanded;
}

function fileURLToPathSafe(u: string): string {
  try {
    return new URL(u).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  } catch {
    return u;
  }
}

async function scanConfigSources(file: string | undefined, layer: "user" | "project", log: ReturnType<typeof createLogger>): Promise<DiscoveredModule[]> {
  const found: DiscoveredModule[] = [];
  if (file === undefined || !existsSync(file)) return found;
  const configDir = join(file, ".."); // §8.2：路径相对本配置文件所在目录
  const doc = parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, Record<string, unknown>>;
  for (const [name, section] of Object.entries(doc)) {
    const spec = section?.["source"];
    if (typeof spec !== "string") continue;
    const root = resolveSourceSpec(spec, configDir);
    if (root === undefined) {
      log.warn("kernel.discover.npm-skip", `模块 ${name} 的 source "${spec}" 是 npm 说明符——npm 分发 M3 落地（§8.6）`);
      continue;
    }
    if (!existsSync(root)) {
      log.warn("kernel.discover.missing", `模块 ${name} 的 source 路径不存在：${root}`, { module: name });
      continue;
    }
    const probed = probeEntry(root);
    if (!probed.ok) {
      if (probed.kind === "pkg-read") log.warn("kernel.discover.skip", `模块 ${name} 的包描述读取失败（package.json：${probed.detail}），跳过`, { module: name });
      else log.warn("kernel.discover.skip", `模块 ${name}（source 目录）无入口，跳过`, { module: name });
      continue;
    }
    try {
      const def = await loadExternalModule(root, probed.entry);
      if (def.name !== name) log.warn("kernel.discover.name-mismatch", `配置 section [${name}] 声明的 source 加载出模块 "${def.name}"——以制品名为准`);
      found.push({ def, source: "local", layer, root, entry: probed.entry, entryHash: sha256(readFileSync(join(root, probed.entry), "utf8")) });
    } catch (err) {
      log.warn("kernel.discover.fail", `模块 ${name}（source）加载失败：${String(err instanceof Error ? err.message : err)}`, { module: name });
    }
  }
  return found;
}

/** 目录扫描入口（§8.3）+ 配置声明式路径 source（§8.2）——同一加载/信任管线；层级决定信任待遇（§8.5）。 */
export async function discoverModules(opts: {
  userDir: string;
  projectDir: string;                 // 项目 .orosus 目录（扫描 mods 与读取 config.toml 的路径 source）
  userFile?: string;                  // 用户配置文件（提取路径 source）
  sink: DiagSink;
}): Promise<DiscoveredModule[]> {
  const log = createLogger(opts.sink, "kernel");
  const projectFile = join(opts.projectDir, "config.toml");
  const [fromUserDir, fromProjectDir, fromUserFile, fromProjectFile] = await Promise.all([
    scanDir(opts.userDir, "user", log),
    scanDir(opts.projectDir, "project", log),
    scanConfigSources(opts.userFile, "user", log),
    scanConfigSources(projectFile, "project", log),
  ]);
  // 去重：同 def.name 时项目级覆盖用户级（§8.7 后者胜出）
  const byName = new Map<string, DiscoveredModule>();
  for (const m of [...fromUserDir, ...fromUserFile, ...fromProjectDir, ...fromProjectFile]) {
    byName.set(m.def.name, m);
  }
  return [...byName.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
}
