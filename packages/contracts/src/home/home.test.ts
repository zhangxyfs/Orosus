import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { orosusHome } from "./index.ts";

describe("orosusHome（M4-2.5 T6——单一解析点）", () => {
  it("① OROSUS_HOME env 非空 → 优先返回", () => {
    expect(orosusHome({ OROSUS_HOME: "D:/oro-data" } as NodeJS.ProcessEnv)).toBe("D:/oro-data");
  });
  it("② 缺省 → ~/.orosus（os.homedir 平台解析）", () => {
    expect(orosusHome({})).toBe(join(homedir(), ".orosus"));
  });
  it("③ env 空串视为未设 → 缺省", () => {
    expect(orosusHome({ OROSUS_HOME: "" } as NodeJS.ProcessEnv)).toBe(join(homedir(), ".orosus"));
  });
});
