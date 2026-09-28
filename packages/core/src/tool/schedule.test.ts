import { describe, it, expect } from "vitest";
import { Access } from "@orosus/contracts/tool";
import { accessConflict, scheduleByAccesses } from "./schedule.ts";

describe("accessConflict（§6.3 冲突矩阵）", () => {
  it("fs.read × fs.read 恒不冲突（同路径也并行）", () => {
    expect(accessConflict(Access.fsRead("/a.ts"), Access.fsRead("/a.ts"))).toBe(false);
  });

  it("fs.write × fs.write：归一化前缀重叠冲突，不重叠不冲突", () => {
    expect(accessConflict(Access.fsWrite("/dir/x.ts"), Access.fsWrite("/dir/y.ts"))).toBe(false);
    expect(accessConflict(Access.fsWrite("/dir/sub/../x.ts"), Access.fsWrite("/dir/x.ts"))).toBe(true); // 归一化后同路径
    expect(accessConflict(Access.fsWrite("/dir"), Access.fsWrite("/dir/deep/z.ts"))).toBe(true); // 前缀按目录边界
  });

  it("fs.write × fs.read：重叠冲突，不重叠不冲突（读撕裂可重试，写破坏不可逆）", () => {
    expect(accessConflict(Access.fsWrite("/dir/x.ts"), Access.fsRead("/dir/x.ts"))).toBe(true);
    expect(accessConflict(Access.fsRead("/dir/x.ts"), Access.fsWrite("/dir/x.ts"))).toBe(true); // 对称
    expect(accessConflict(Access.fsWrite("/a.ts"), Access.fsRead("/b.ts"))).toBe(false);
  });

  it("network × network：同 host 冲突，异 host 不冲突", () => {
    expect(accessConflict(Access.network("api.x.com"), Access.network("api.x.com"))).toBe(true);
    expect(accessConflict(Access.network("api.x.com"), Access.network("api.y.com"))).toBe(false);
  });

  it("subprocess × subprocess 冲突（子进程是重资源，保守默认）", () => {
    expect(accessConflict(Access.subprocess(), Access.subprocess())).toBe(true);
  });

  it("subprocess × fs.write/network 冲突（跨 kind 例外——不透明执行）；× fs.read 不冲突", () => {
    expect(accessConflict(Access.subprocess(), Access.fsWrite("/any"))).toBe(true);
    expect(accessConflict(Access.subprocess(), Access.network("any.host"))).toBe(true);
    expect(accessConflict(Access.subprocess(), Access.fsRead("/any"))).toBe(false);
  });

  it("kind:\"all\" 与一切冲突（独占执行）", () => {
    expect(accessConflict(Access.all(), Access.fsRead("/a"))).toBe(true);
    expect(accessConflict(Access.fsRead("/a"), Access.all())).toBe(true); // 对称
    expect(accessConflict(Access.all(), Access.subprocess())).toBe(true);
    expect(accessConflict(Access.all(), Access.all())).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("win32 路径归一化：盘符大小写不影响前缀重叠判定（trust 同款坑）", () => {
    expect(accessConflict(Access.fsWrite("D:\\dir\\x.ts"), Access.fsRead("d:/dir/x.ts"))).toBe(true);
    expect(accessConflict(Access.fsWrite("D:\\a\\x.ts"), Access.fsRead("d:/b/x.ts"))).toBe(false);
  });
});

describe("scheduleByAccesses（D40 贪心分组：最早无冲突组，确定性）", () => {
  it("贪心最早组：A、B 无冲突同组；C 与 A 冲突开新组；D 与 A 冲突与 C 无冲突进组 2", () => {
    const groups = scheduleByAccesses([
      { accesses: [Access.fsRead("/a")] },        // 0: A
      { accesses: [Access.network("h1")] },       // 1: B（与 A 不冲突）
      { accesses: [Access.fsWrite("/a")] },       // 2: C（与 A 冲突、与 B 不冲突）
      { accesses: [Access.all()] },               // 3: D（与一切冲突）
    ]);
    expect(groups).toEqual([[0, 1], [2], [3]]);
  });

  it("全无冲突 → 单组；链式互斥 → 每组一个", () => {
    expect(scheduleByAccesses([
      { accesses: [Access.fsRead("/a")] },
      { accesses: [Access.fsRead("/b")] },
    ])).toEqual([[0, 1]]);
    expect(scheduleByAccesses([
      { accesses: [Access.subprocess()] },
      { accesses: [Access.subprocess()] },
      { accesses: [Access.subprocess()] },
    ])).toEqual([[0], [1], [2]]);
  });

  it("CX-16：注入 cwd 锚定相对路径——同相对路径跨不同 cwd 判冲/分组不串（缺省 process.cwd 兼容旧行为）", () => {
    const isWin = process.platform === "win32";
    const cwdA = isWin ? "D:\\proj-a" : "/proj-a";
    const cwdB = isWin ? "D:\\proj-b" : "/proj-b";
    const abs = isWin ? "D:\\proj-a\\x.ts" : "/proj-a/x.ts";
    // accessConflict 三参形态：相对 "x.ts" 在 cwdA 下与绝对路径同文件 → 冲突；锚到 cwdB 则是另一文件
    expect(accessConflict(Access.fsWrite("x.ts"), Access.fsWrite(abs), cwdA)).toBe(true);
    expect(accessConflict(Access.fsWrite("x.ts"), Access.fsWrite(abs), cwdB)).toBe(false);
    // 分组同口径：cwdA → 同文件分错开（串行）；cwdB → 互不相干同组（并行）。
    // 旧实现裸 process.cwd：相对路径永远锚主进程 cwd，嵌入宿主/注入 cwd 场景下判冲错组
    expect(scheduleByAccesses([{ accesses: [Access.fsWrite("x.ts")] }, { accesses: [Access.fsWrite(abs)] }], cwdA)).toEqual([[0], [1]]);
    expect(scheduleByAccesses([{ accesses: [Access.fsWrite("x.ts")] }, { accesses: [Access.fsWrite(abs)] }], cwdB)).toEqual([[0, 1]]);
  });
});
