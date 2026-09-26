import { describe, it, expect } from "vitest";
import { BUILTIN_ROLES, resolveRole } from "./builtin-roles.ts";
import type { RoleFile } from "./roles.ts";

describe("内置工种 T4（设计空白名录：research 只读型 + general 通用写型）", () => {
  it("⑨ 两个内置工种形状 + 只读型无写无 shell + 文件工种压过内置同名 + 未知名 undefined", () => {
    expect(BUILTIN_ROLES.map((r) => r.name)).toEqual(["research", "general"]);
    const research = BUILTIN_ROLES[0]!;
    expect(research.tools).toEqual(["tool-fs__read", "tool-fs__glob", "tool-fs__grep", "tool-web__search", "tool-web__fetch"]); // 读三件 + 网搜两件（名字实锚 tool-web 源码）
    expect(research.tools!.some((t) => t.includes("write") || t.includes("edit") || t.includes("bash"))).toBe(false);
    expect(research.prompt).not.toBe("");
    const general = BUILTIN_ROLES[1]!;
    expect(general.tools).toBeUndefined(); // 通用写型 = 全工具面不加限（默认工种——kimi 默认 coder 同位）
    expect(general.prompt).not.toBe("");

    expect(resolveRole("research", new Map())).toBe(research); // 无文件时内置兜底
    const custom: RoleFile = {
      name: "research", description: "自定义调研员", prompt: "自定义正文", source: "/x/research.md",
      tools: ["tool-fs__read"],
    };
    expect(resolveRole("research", new Map([["research", custom]]))).toBe(custom); // 文件压过内置
    expect(resolveRole("nope", new Map())).toBeUndefined();
  });
});
