import { describe, it, expect } from "vitest";
import { defineModule } from "@orosus/contracts/module";
import { validateModule } from "./validate.ts";

const base = { version: "0.1.0", description: "x", api: 1, activate() {} };

describe("defineModule 静态校验（§4.2 第 4 步）", () => {
  it("合法定义通过", () => {
    expect(validateModule(defineModule({ ...base, name: "tool-x" }))).toEqual([]);
  });

  it("name 非 kebab-case → 违规", () => {
    expect(validateModule(defineModule({ ...base, name: "Tool_X" })).length).toBeGreaterThan(0);
  });

  it("api 主版本不兼容 → 违规", () => {
    const v = validateModule(defineModule({ ...base, name: "a", api: 99 }));
    expect(v.some((m) => m.includes("api"))).toBe(true);
  });

  it("provides 公共短名未在 contracts 登记且无前缀 → 违规（规则 1）", () => {
    const v = validateModule(defineModule({ ...base, name: "a", provides: ["database"] }));
    expect(v.some((m) => m.includes("database"))).toBe(true);
  });

  it("provides 带模块名前缀的新能力 → 合法", () => {
    expect(validateModule(defineModule({ ...base, name: "gitlab", provides: ["gitlab.api"] }))).toEqual([]);
  });

  it("logEvents 不带 <module>/ 前缀 → 违规（规则 4）", () => {
    const v = validateModule(defineModule({ ...base, name: "a", logEvents: ["other/thing"] }));
    expect(v.some((m) => m.includes("logEvents"))).toBe(true);
  });

  it("logEvents owner 正向（M3 补强 T5 四轮 P1）：compaction 名义声明核心类型过校验；其他核心类型仍拒（M3 计划⑤正向例的独立落地）", () => {
    expect(validateModule(defineModule({ ...base, name: "compaction", logEvents: ["turn/compaction", "turn/prune"] })).filter((m) => m.includes("logEvents"))).toEqual([]);
    const bad = validateModule(defineModule({ ...base, name: "compaction", logEvents: ["turn/start"] }));
    expect(bad.some((m) => m.includes("logEvents"))).toBe(true);
  });

  it("owner 拒绝：他模块声明 turn/prune 被拒（认识类型 ≠ 能写——类型制残余的钉子）", () => {
    const v = validateModule(defineModule({ ...base, name: "evil", logEvents: ["turn/prune"] }));
    expect(v.some((m) => m.includes("logEvents"))).toBe(true);
  });

  it("保留槽 key 不得出现在 provides 声明（§7.2：不计入声明、由 provide 注册）", () => {
    const v = validateModule(defineModule({ ...base, name: "a", provides: ["provider:x"] }));
    expect(v.some((m) => m.includes("保留槽"))).toBe(true);
  });
});
