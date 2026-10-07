import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { t } from "./i18n/app.ts";

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

const USAGE = t("home.usage");

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
    io.out(`${t("home.path.header", { home: home })}`);
    for (const [name, rel] of [["config", "config.toml"], ["modules.d", "modules.d"], ["sessions", "sessions"], ["cache", "cache"]] as const) { // m5-i18n T9：目录名不翻（专名），原中文括注退役
      const p = `${home}/${rel}`;
      io.out(`  ${name}: ${p}${existsSync(p) ? "" : t("home.path.missing")}`);
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
  if (dest === resolve(source)) { io.out(`${t("home.sameTarget", { dest: dest })}`); return 1; }
  if (!existsSync(source)) { io.out(`${t("home.noSource", { source: source })}`); return 1; }
  // CM-10（2026-09-28 code review）：目标在源内 → 前置人话拒绝（fs.cp 自拷贝会拒，但报错形态不友好且
  // 在无兜底期直接裸抛）；win32 路径大小写不敏感受理
  const insideSource = process.platform === "win32"
    ? dest.toLowerCase().startsWith(resolve(source).toLowerCase() + sep)
    : dest.startsWith(resolve(source) + sep);
  if (insideSource) { io.out(`${t("home.insideSource", { dest: dest })}`); return 1; }
  if (existsSync(dest)) {
    if (!dirEmpty(dest)) { io.out(`${t("home.destNotEmpty", { dest: dest })}`); return 1; }
  }

  const plan = walk(source);
  if (!apply) {
    io.out(t("home.plan.header"));
    io.out(t("home.plan.source", { source, n: plan.files, b: plan.bytes }));
    io.out(t("home.plan.dest", { dest }));
    io.out(t("home.plan.after", { source }));
    return 0;
  }

  // apply：复制 → 双侧校验 → 校验过才改名留证
  // CM-10：复制/校验/改名任一步抛错（盘满、EACCES、长路径、Windows 目录占用 EPERM/EBUSY）此前直接穿透
  // = 裸堆栈退出 + 已复制目标残留盘上 + 退出码不可控——文件头「任一步失败清理目标已复制部分、源不动、
  // 退出码 1」的承诺在此兑现。rename 失败必在生效前抛（同步操作无半完成态），catch 内源恒未动
  const ts = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const renamed = `${source}.pre-migrate-${ts}`;
  try {
    if (io.copy !== undefined) io.copy(source, dest);
    else cpSync(source, dest, { recursive: true });
    const got = walk(dest);
    if (got.files !== plan.files || got.bytes !== plan.bytes) {
      rmSync(dest, { recursive: true, force: true });
      io.out(t("home.verifyFail", { a: got.files, b: got.bytes, c: plan.files, d: plan.bytes }));
      return 1;
    }
    renameSync(source, renamed);
  } catch (err) {
    try {
      rmSync(dest, { recursive: true, force: true }); // 清理已复制部分（清理自身失败不掩盖原始错误）
    } catch {
      io.out(`${t("home.cleanupFail", { dest: dest })}`);
    }
    io.out(t("home.migrateFail", { err: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
  io.out(t("home.migrateDone", { n: plan.files, b: plan.bytes, dest }));
  io.out(`${t("home.renamed", { renamed: renamed })}`);
  // 生效指引：env 写入失败不回滚迁移（目标完好+源留证，数据双份安全）——改打印手动行
  if (process.platform === "win32") {
    try {
      io.setEnv?.(dest);
      io.out(`${t("home.setxOk", { dest: dest })}`);
    } catch {
      io.out(t("home.setxFail", { dest }));
    }
  } else {
    io.out(t("home.exportHint"));
    io.out(`  export OROSUS_HOME="${dest}"`);
  }
  io.out(t("home.otherTerminals"));
  return 0;
}
