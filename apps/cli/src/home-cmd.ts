import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** `orosus home path` / `orosus home migrate <目标> [--dry-run|--apply]`（M4-2.5 T6——ROADMAP 迁移 ②）。
 *  纪律与 prune 同款：移动性操作当删除性对待——缺省 dry-run、显式 --apply 才动；
 *  apply = 复制 → 双侧文件数+字节校验 → **校验过才**把源改名 `<源>.pre-migrate-<ts>` 留证（绝不删）；
 *  任一步失败清理目标已复制部分、源不动、退出码 1。walk 用 readdirSync recursive（Node ≥22 原生——
 *  不复用 D46 会话分桶扫描：那是 sessions 两层结构专用件，本命令遍历整棵 home 树，不同物）。 */
export function isHomeSubcommand(argv: string[]): boolean {
  return argv[0] === "home";
}

export interface HomeIo {
  /** 迁移源（= 当前解析结果，main 接线 orosusHome()）。 */
  sourceHome: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  /** Windows：setx 写入用户环境变量（main 接线 execFileSync；失败不回滚——数据双份安全，改打印手动行）。 */
  setEnv?(v: string): void;
  /** 复制注入（默认 fs.cp recursive）——测试注入字节差走校验失败路径。 */
  copy?(from: string, to: string): void;
}

const USAGE = "用法: orosus home path | orosus home migrate <目标路径> [--dry-run|--apply]（migrate 缺省 dry-run）";

/** 递归统计：文件数 + 总字节（readdirSync recursive 原生）。 */
const walk = (root: string): { files: number; bytes: number } => {
  let files = 0;
  let bytes = 0;
  for (const rel of readdirSync(root, { recursive: true })) {
    const abs = `${root}/${String(rel).replaceAll("\\", "/")}`;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isFile()) { files++; bytes += st.size; }
  }
  return { files, bytes };
};

const dirEmpty = (p: string): boolean => readdirSync(p).length === 0;

export async function runHomeSubcommand(argv: string[], io: HomeIo): Promise<number> {
  const sub = argv[1] ?? "";
  if (sub === "path") {
    const home = io.sourceHome; // main 接线 orosusHome() 的解析结果（env 已在接线时消费）
    io.out(`OROSUS_HOME 解析结果: ${home}`);
    for (const [name, rel] of [["config", "config.toml"], ["sessions", "sessions"], ["cache", "cache"]] as const) {
      const p = `${home}/${rel}`;
      io.out(`  ${name}: ${p}${existsSync(p) ? "" : "（不存在）"}`);
    }
    return 0;
  }
  if (sub !== "migrate") {
    io.out(USAGE);
    return 1;
  }
  const target = argv[2];
  if (target === undefined || target === "") { io.out(USAGE); return 1; }
  const apply = argv.includes("--apply");
  const source = io.sourceHome;
  const dest = resolve(target);
  if (dest === resolve(source)) { io.out(`目标与源相同：${dest}`); return 1; }
  if (!existsSync(source)) { io.out(`源目录不存在：${source}（先启动一次 orosus 生成，或检查 OROSUS_HOME）`); return 1; }
  if (existsSync(dest)) {
    if (!dirEmpty(dest)) { io.out(`目标已存在且非空，拒绝：${dest}（不会覆盖任何已有数据）`); return 1; }
  }

  const plan = walk(source);
  if (!apply) {
    io.out(`[dry-run] 迁移计划（不复制、不改名——加 --apply 执行）：`);
    io.out(`  源:   ${source}（${plan.files} 个文件，${plan.bytes} 字节）`);
    io.out(`  目标: ${dest}`);
    io.out(`  执行后: 目标持有全部数据；源改名 ${source}.pre-migrate-<时间戳> 留证（绝不删）`);
    return 0;
  }

  // apply：复制 → 双侧校验 → 校验过才改名留证
  if (io.copy !== undefined) io.copy(source, dest);
  else cpSync(source, dest, { recursive: true });
  const got = walk(dest);
  if (got.files !== plan.files || got.bytes !== plan.bytes) {
    rmSync(dest, { recursive: true, force: true });
    io.out(`校验失败：目标 ${got.files} 文件/${got.bytes} 字节 ≠ 源 ${plan.files} 文件/${plan.bytes} 字节——目标已清理，源未动`);
    return 1;
  }
  const ts = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const renamed = `${source}.pre-migrate-${ts}`;
  renameSync(source, renamed);
  io.out(`迁移完成：${plan.files} 个文件/${plan.bytes} 字节 → ${dest}`);
  io.out(`源已改名留证（绝不删，确认无误后可自行删除）：${renamed}`);
  // 生效指引：env 写入失败不回滚迁移（目标完好+源留证，数据双份安全）——改打印手动行
  if (process.platform === "win32") {
    try {
      io.setEnv?.(dest);
      io.out(`已写入用户环境变量 OROSUS_HOME=${dest}（setx）——重开终端生效`);
    } catch {
      io.out(`自动 setx 失败——请手动执行: setx OROSUS_HOME "${dest}" 后重开终端`);
    }
  } else {
    io.out(`请将以下行加入 shell 配置（~/.bashrc / ~/.zshrc）后重开终端：`);
    io.out(`  export OROSUS_HOME="${dest}"`);
  }
  io.out(`注意：其他已开的终端仍指向旧根——重开前勿在其中启动 orosus（旧根已改名，旧终端启动会重建空目录）`);
  return 0;
}
