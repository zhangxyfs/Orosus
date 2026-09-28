import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { orosusHome } from "./index.ts";

describe("orosusHome（M4-2.5 T6——单一解析点）", () => {
  it("① OROSUS_HOME env 非空 → 优先返回（CT-03：resolve 归一为绝对路径，含首尾空白 trim）", () => {
    expect(orosusHome({ OROSUS_HOME: "D:/oro-data" } as NodeJS.ProcessEnv)).toBe(resolve("D:/oro-data"));
    expect(orosusHome({ OROSUS_HOME: "  D:/oro-data  " } as NodeJS.ProcessEnv)).toBe(resolve("D:/oro-data"));
  });
  it("② 缺省 → ~/.orosus（os.homedir 平台解析）", () => {
    expect(orosusHome({})).toBe(join(homedir(), ".orosus"));
  });
  it("③ env 空串视为未设 → 缺省", () => {
    expect(orosusHome({ OROSUS_HOME: "" } as NodeJS.ProcessEnv)).toBe(join(homedir(), ".orosus"));
  });
  it("④ CT-03：纯空白串 trim 后视为未设 → 缺省（原实现会把 \" \" 当合法值原样返回）", () => {
    expect(orosusHome({ OROSUS_HOME: "   " } as NodeJS.ProcessEnv)).toBe(join(homedir(), ".orosus"));
  });
  it("⑤ CT-03：相对路径按进程 cwd resolve 固化为绝对——不再随启动目录漂移读到不同的 config/secrets", () => {
    expect(orosusHome({ OROSUS_HOME: ".oro" } as NodeJS.ProcessEnv)).toBe(resolve(".oro"));
    expect(orosusHome({ OROSUS_HOME: join("sub", "dir") } as NodeJS.ProcessEnv)).toBe(resolve(join("sub", "dir")));
  });
  it("⑥ CT-03：开头的 ~ 展开为用户主目录（兜底 shell 未展开形态，避免 resolve 成 <cwd>/~）", () => {
    expect(orosusHome({ OROSUS_HOME: "~" } as NodeJS.ProcessEnv)).toBe(homedir());
    expect(orosusHome({ OROSUS_HOME: "~/.oro-data" } as NodeJS.ProcessEnv)).toBe(resolve(join(homedir(), ".oro-data")));
  });
});
