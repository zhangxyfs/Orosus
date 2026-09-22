import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** TUI 模式解析（F6）：--tui 旗标 > 配置 [tui] mode > 缺省（TTY=full / 非TTY=line）。
 *  配置值非法（非 full|line）按未配置处理——缺省兜底，不炸不警告屏。 */
export function resolveTuiMode(flag: "line" | "full" | undefined, cfgMode: string | undefined, isTTY: boolean): "line" | "full" {
  if (flag !== undefined) return flag;
  if (cfgMode === "full" || cfgMode === "line") return cfgMode;
  return isTTY ? "full" : "line";
}

/** LaTeX 数学渲染开关解析（mdpipe 批 T7，设计空白 #12）：[tui] latex，布尔、缺省 true（开）。
 *  非法值（非布尔）按未配置处理——缺省兜底不炸，与 resolveTuiMode 同式；
 *  生效时机 = 启动读一次，改配置重启生效（设计空白 #13——/reload 热切换不做）。 */
export function resolveLatexFlag(cfgLatex: unknown): boolean {
  return typeof cfgLatex === "boolean" ? cfgLatex : true;
}

/** 字节数人性化（磁盘占用视图用）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 目录占用（递归求和；坏项跳过——视图是尽力面）。 */
export function dirUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // 无权限/已删除——尽力统计
    }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          bytes += statSync(p).size;
          files++;
        }
      } catch {
        /* 单文件失败跳过 */
      }
    }
  };
  walk(dir);
  return { bytes, files };
}
