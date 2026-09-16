import { describe, it, expect } from "vitest";
import { checkPackage } from "../../scripts/check-boundaries.mts";

describe("import 边界检查（§11.1）", () => {
  it("模块包 import core → 违规", () => {
    const violations = checkPackage(
      { name: "@orosus/tool-x", orosus: { module: true }, dependencies: { "@orosus/core": "workspace:*" } },
      [],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("@orosus/core");
  });

  it("模块包只 import contracts → 合规", () => {
    const violations = checkPackage(
      { name: "@orosus/tool-x", orosus: { module: true }, dependencies: { "@orosus/contracts": "workspace:*", zod: "^4.0.0" } },
      [],
    );
    expect(violations).toHaveLength(0);
  });

  it("契约包声明运行时依赖（zod 以外）→ 违规", () => {
    const violations = checkPackage(
      { name: "@orosus/contracts", orosus: { contract: true }, dependencies: { "smol-toml": "^1.0.0" } },
      [],
    );
    expect(violations).toHaveLength(1);
  });
});
