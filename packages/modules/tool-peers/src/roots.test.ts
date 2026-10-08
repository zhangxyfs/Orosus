import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeCwd } from "@orosus/core";   // devDependency 对拍合法（自研点表：运行时不依赖 core、测试对拍防漂移）
import { encodeCwdLike, findGitRoot, memoryBucketKey } from "./roots.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "peers-roots-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("encodeCwdLike（core encodeCwd 复刻对拍）", () => {
  it("多组输入与 core 原件逐字一致（win 盘符/中文/长路径截断/纯符号回退）", () => {
    const cases = [
      "D:\\develop\\Orosus",
      "C:\\Users\\someone\\项目仓库",
      "/home/user/work",
      `D:\\${"很长的目录名".repeat(12)}\\deep`,
      "::??##",                       // 纯符号——清洗段全消、hash 兜底
      "C:\\a.b-c_d",                  // [A-Za-z0-9._-] 保留集
    ];
    for (const c of cases) expect(encodeCwdLike(c)).toBe(encodeCwd(c));
  });
  it("形态钉：清洗段 + sha1 前 8 hex（D--develop-Orosus-524861ea 同族）", () => {
    expect(encodeCwdLike("D:\\develop\\Orosus")).toMatch(/^D--develop-Orosus-[0-9a-f]{8}$/);
  });
});

describe("findGitRoot（自 main.ts 下沉，逻辑不变）", () => {
  it("向上找 .git；到根没有回退 cwd", () => {
    const gitDir = join(root, "repo");
    mkdirSync(join(gitDir, ".git"), { recursive: true });
    const sub = join(gitDir, "packages", "modules", "deep");
    mkdirSync(sub, { recursive: true });
    expect(findGitRoot(sub)).toBe(gitDir);
    expect(findGitRoot(gitDir)).toBe(gitDir);
    const noGit = join(root, "plain");
    mkdirSync(noGit);
    expect(findGitRoot(noGit)).toBe(noGit);   // 无 .git → cwd 自身（探测退化）
  });
});

describe("memoryBucketKey（= encodeCwd(findGitRoot(cwd))）", () => {
  it("子目录与仓库根同键（坑 2 语义：同仓一份记忆）", () => {
    const gitDir = join(root, "repo");
    mkdirSync(join(gitDir, ".git"), { recursive: true });
    const sub = join(gitDir, "packages");
    mkdirSync(sub, { recursive: true });
    expect(memoryBucketKey(sub)).toBe(memoryBucketKey(gitDir));
    expect(memoryBucketKey(gitDir)).toBe(encodeCwdLike(gitDir));   // 根自身 = 裸键
  });
  it("非 git 目录 = 裸 cwd 键（回退 D1）", () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    expect(memoryBucketKey(dir)).toBe(encodeCwdLike(dir));
  });
});
