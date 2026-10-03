import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atMenuEntries } from "./at-menu-entries.ts";

/** m5-at-menu T5：宿主数据源直测（纯函数——不起 FullApp 不 spawn）。dir 语义 = 相对
 *  process.cwd()——测试用 process.chdir 切进 mkdtemp 临时目录（afterEach 切回，防泄漏
 *  影响并行用例的工作目录）。 */

let dir: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "orosus-atmenu-"));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("m5-at-menu T5：atMenuEntries 数据源（目录/文件/符号链接归类 + 排序 + 空态）", () => {
  it("① 三类归类：目录/文件/符号链接（跟随判定真实类型；断链按文件）", () => {
    mkdirSync(join(dir, "real-dir"));
    writeFileSync(join(dir, "file.txt"), "x", "utf8");
    if (process.platform !== "win32") {
      symlinkSync(join(dir, "real-dir"), join(dir, "link-to-dir"));
      symlinkSync(join(dir, "nowhere"), join(dir, "link-broken"));
    } else {
      // win32 无特权创建目录链接：junction 形态（跟随判定同样成立）
      symlinkSync(join(dir, "real-dir"), join(dir, "link-to-dir"), "junction");
    }
    const { entries, miss } = atMenuEntries("");
    expect(miss).toBeUndefined();
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.dir]));
    expect(byName["real-dir"]).toBe(true);
    expect(byName["file.txt"]).toBe(false);
    expect(byName["link-to-dir"]).toBe(true); // 符号链接跟随判定（D7）
    if (process.platform !== "win32") expect(byName["link-broken"]).toBe(false); // 断链按文件（stat 失败）
  });
  it("② 排序（D6）：目录在前、各组码元升序（非 localeCompare——大小写与本地化无关）", () => {
    mkdirSync(join(dir, "zed"));
    mkdirSync(join(dir, "Alpha"));
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    writeFileSync(join(dir, "B.txt"), "x", "utf8");
    const { entries } = atMenuEntries("");
    expect(entries.map((e) => e.name)).toEqual(["Alpha", "zed", "B.txt", "a.txt"]); // 码元序 B < a（大写在前）
  });
  it("③ 子目录路径与空态：dir 相对路径现读；空目录 entries []、不存在 miss", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "inner.ts"), "x", "utf8");
    expect(atMenuEntries("sub").entries).toEqual([{ name: "inner.ts", dir: false }]);
    expect(atMenuEntries("sub")).toEqual({ entries: [{ name: "inner.ts", dir: false }] });
    mkdirSync(join(dir, "empty"));
    expect(atMenuEntries("empty")).toEqual({ entries: [] }); // 空目录（无 miss）
    expect(atMenuEntries("nosuch")).toEqual({ entries: [], miss: true }); // 目录不存在
  });
});
