import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { trustModule, loadTrustStore, checkTrust } from "@orosus/core";

/** CLI module 子命令（§8.6）：enable/disable/list/trust——配置与信任的写器（非交互入口，§8.5 确认门的命令式路径）。 */
export interface ModuleCmdIo {
  configPath: string;
  trustFile: string;
  discovered: { name: string; root: string; entryHash: string; layer?: "user" | "project" }[];
  out(line: string): void;
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
}

export function isModuleSubcommand(argv: string[]): boolean {
  return argv[0] === "module";
}

export async function runModuleSubcommand(argv: string[], io: ModuleCmdIo): Promise<number> {
  const cmd = argv[1];
  const name = argv[2];

  if (cmd === "list") {
    io.out("已发现模块：");
    const store = loadTrustStore(io.trustFile);
    for (const m of io.discovered) {
      const layer = m.layer ?? "project";
      const t = checkTrust({ layer, root: m.root, entryHash: m.entryHash, store });
      const status = layer === "user" ? "active（用户级）" : t.ok ? "active（已确认）" : t.reason === "unconfirmed" ? "failed (untrusted——module trust 后生效)" : "failed (untrusted——hash 已变化，须重新确认)";
      io.out(`  ${m.name}: ${status}`);
    }
    if (io.discovered.length === 0) io.out("  （无）");
    return 0;
  }

  if (cmd === "trust") {
    const m = io.discovered.find((x) => x.name === name);
    if (m === undefined) {
      io.out(`未发现模块 "${name ?? ""}"——trust 需要已发现的模块名`);
      return 1;
    }
    trustModule(io.trustFile, m.root, m.entryHash);
    io.out(`已确认 ${name}（内容 hash 已登记；重启或 /reload 生效）`);
    return 0;
  }

  if (cmd === "enable" || cmd === "disable") {
    if (name === undefined) {
      io.out(`用法: orosus module ${cmd} <name>`);
      return 1;
    }
    const config = readConfig(io.configPath);
    const section = (config[name] as Record<string, unknown> | undefined) ?? {};
    section["enabled"] = cmd === "enable";
    config[name] = section;
    writeFileSync(io.configPath, stringify(config), "utf8");
    io.out(`${name} 已${cmd === "enable" ? "启用" : "禁用"}（重启或 /reload 生效；配置已全量重写，注释已移除）`);
    return 0;
  }

  io.out("用法: orosus module list | enable <name> | disable <name> | trust <name>");
  return 1;
}
