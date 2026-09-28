import { trustModule, loadTrustStore, checkTrust } from "@orosus/core";
import { join, dirname } from "node:path";
import { sectionPath } from "@orosus/core";
import { setModuleEnabledInConfig } from "./module-toggle.ts";

/** CLI module 子命令（§8.6）：enable/disable/list/trust——配置与信任的写器（非交互入口，§8.5 确认门的命令式路径）。 */
export interface ModuleCmdIo {
  configPath: string;
  trustFile: string;
  discovered: { name: string; root: string; entryHash: string; layer?: "user" | "project" }[];
  out(line: string): void;
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
      // CM-09（2026-09-28 code review）：用户级模块同样要确认（trust.ts：user 层未登记 = unconfirmed →
      // pending-confirm 不挂载；m5 T17 首挂弹窗与 main 的「项目级 hash 门/用户级认登记共用 trust.json」同源）——
      // 旧硬编码 "active（用户级）" 把从未确认的用户级模块误报为已激活（信任决策面误导）。两层统一走 t.ok
      // 判定，仅文案分层；project 层既有 untrusted 两态（unconfirmed / hash 变化）保持不变
      const status = t.ok
        ? layer === "user" ? "active（用户级·已确认）" : "active（已确认）"
        : t.reason === "unconfirmed"
          ? layer === "user" ? "pending-confirm（用户级——module trust 后生效）" : "failed (untrusted——module trust 后生效)"
          : "failed (untrusted——hash 已变化，须重新确认)";
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
    // CM-14（2026-09-28 code review）：写盘迁 module-toggle.ts 的行级节区感知写——与 /permission、
    // 模块面板热插拔同一件（旧 parse→stringify 全量重写洗掉用户注释与键序，输出文案自认，与仓内
    // 「行级写 TOML 必须节区感知」铁律两口径）。语义不变：[name] 节内 enabled 键改/插，节外一概不动
    // m4-8 T3：模块节路由 modules.d/<名>.toml（本命令只对模块名操作——isModule 恒真；目录/文件由 sectionPath 建）
    setModuleEnabledInConfig(name, cmd === "enable", sectionPath(name, { userConfig: io.configPath, modulesDir: join(dirname(io.configPath), "modules.d"), isModule: () => true }));
    io.out(`${name} 已${cmd === "enable" ? "启用" : "禁用"}（重启或 /reload 生效；配置已写入 modules.d/${name}.toml）`);
    return 0;
  }

  io.out("用法: orosus module list | enable <name> | disable <name> | trust <name>");
  return 1;
}
