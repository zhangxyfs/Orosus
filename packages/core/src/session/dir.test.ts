import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd, locateSessionBucket, locateSessionFile, scanSessionFiles } from "./dir.ts";

let dir: string | undefined;
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-dir-")));
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/** 新形态夹具：在 root 的 bucket 桶里放一个「每会话一目录」会话（agents/session.jsonl）。 */
const seedSession = (root: string, bucket: string, sid: string, ext = "jsonl"): string => {
  const agents = join(root, bucket, sid, "agents");
  mkdirSync(agents, { recursive: true });
  const file = join(agents, `session.${ext}`);
  writeFileSync(file, `${JSON.stringify({ v: 1, id: "e1", parentId: null, seq: 1, ts: "t", type: "session/header" })}\n`);
  return file;
};

describe("encodeCwd（D46 桶名编码——清洗 + 8 hex hash 防碰撞）", () => {
  it("① Windows 盘符路径：清洗为合法字符 + hash 后缀，且幂等", () => {
    const cwd = "D:\\develop\\Orosus";
    const enc = encodeCwd(cwd);
    expect(enc).toMatch(/^D--develop-Orosus-[0-9a-f]{8}$/);
    expect(encodeCwd(cwd)).toBe(enc); // 幂等（同输入同输出）
  });

  it("② 非法字符全部替换：结果只含 [A-Za-z0-9._-] 与末段 hash", () => {
    const enc = encodeCwd("C:\\pro?ject|x*>y");
    expect(enc).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
    expect(enc.startsWith("C--pro-ject-x--y")).toBe(true); // ?|*> 全部落为 -
  });

  it("③ 同尾名不同路径不碰撞：清洗结果相同、hash 后缀区分", () => {
    const a = encodeCwd("C:\\a\\b");
    const b = encodeCwd("C:\\a?b");
    expect(a).toMatch(/^C--a-b-[0-9a-f]{8}$/);
    expect(b).toMatch(/^C--a-b-[0-9a-f]{8}$/); // 清洗后同形
    expect(a).not.toBe(b); // hash 防碰撞
  });
});

describe("scanSessionFiles 目录化新形态（会话树批 T2——只认 <桶>/<sid>/agents/session.*）", () => {
  it("① 目录形态扫出：id = 目录名、file 指向 agents/ 主文件、dir = 会话目录、bucket 装桶名", () => {
    const root = fresh();
    const f1 = seedSession(root, "B-one", "s_a");
    const f2 = seedSession(root, "B-one", "s_b", "sqlite");
    seedSession(root, "B-two", "s_c");
    const out = scanSessionFiles(root);
    expect(out).toHaveLength(3);
    const a = out.find((e) => e.id === "s_a")!;
    expect(a.file).toBe(f1);
    expect(a.dir).toBe(join(root, "B-one", "s_a"));
    expect(a.bucket).toBe("B-one");
    const b = out.find((e) => e.id === "s_b")!;
    expect(b.file).toBe(f2); // sqlite 主文件同认
    expect(out.every((e) => typeof e.mtimeMs === "number")).toBe(true);
  });

  it("② 平铺遗留不识别（拍板钉：桶根裸平铺与根平铺一律不列——历史会话由用户手动清理）", () => {
    const root = fresh();
    mkdirSync(join(root, "B-one"), { recursive: true });
    writeFileSync(join(root, "B-one", "s_flat.jsonl"), "{}\n"); // 桶内裸平铺
    writeFileSync(join(root, "s_root.jsonl"), "{}\n");          // 根平铺
    expect(scanSessionFiles(root)).toEqual([]);
  });

  it("③ 无 agents/ 主文件的会话目录与 spill/ 等其余内容自然跳过；单桶不可读不炸整体", () => {
    const root = fresh();
    mkdirSync(join(root, "B-one", "s_orphan"), { recursive: true }); // 空会话目录
    mkdirSync(join(root, "B-one", "s_ok", "spill"), { recursive: true }); // 只有 spill 没有 agents
    seedSession(root, "B-one", "s_real");
    const out = scanSessionFiles(root);
    expect(out.map((e) => e.id)).toEqual(["s_real"]);
  });

  it("④ 按 mtime 倒序（最新最前）", () => {
    const root = fresh();
    seedSession(root, "B", "s_old");
    seedSession(root, "B", "s_new"); // 后写 = 更新
    const out = scanSessionFiles(root);
    expect(out.map((e) => e.id)).toEqual(["s_new", "s_old"]);
  });

  it("⑤ locateSessionFile：全域定位 + bucket 限定（他桶 sid 落空——#17 交互面拒他桶）", () => {
    const root = fresh();
    seedSession(root, "B-one", "s_a");
    seedSession(root, "B-two", "s_b");
    expect(locateSessionFile(root, "s_a")?.bucket).toBe("B-one");
    expect(locateSessionFile(root, "s_b", { bucket: "B-one" })).toBeUndefined(); // 桶限定拒他桶
    expect(locateSessionFile(root, "s_b", { bucket: "B-two" })?.id).toBe("s_b");
    expect(locateSessionFile(root, "s_nope")).toBeUndefined();
  });

  it("⑥ locateSessionBucket：同桶 hint 快路径命中、跨桶走全根扫描、找不到 undefined（快路径按新形态查）", () => {
    const root = fresh();
    seedSession(root, "B-one", "s_a");
    // hint = 该会话所在桶 → 直返（不依赖 root 扫描）
    expect(locateSessionBucket(undefined, "s_a", join(root, "B-one"))).toBe(join(root, "B-one"));
    // hint 落空 + root 兜底找到跨桶祖先
    expect(locateSessionBucket(root, "s_a", join(root, "B-two"))).toBe(join(root, "B-one"));
    // 两路都落空
    expect(locateSessionBucket(root, "s_nope", join(root, "B-two"))).toBeUndefined();
    expect(locateSessionBucket(undefined, "s_a")).toBeUndefined();
  });
});
