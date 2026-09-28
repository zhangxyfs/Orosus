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

  // 代码面（TS-04 修复）：package.json 只是意图声明，import 语句才是事实——devDependencies
  // 塞 @orosus/core 与相对路径越界两个绕过通道由真实源码扫描关闭
  it("模块包发货代码 import core（经 devDependencies 绕过声明面）→ 违规", () => {
    const violations = checkPackage(
      { name: "@orosus/tool-todo", orosus: { module: true }, dependencies: { "@orosus/contracts": "workspace:*" }, devDependencies: { "@orosus/core": "workspace:*" } },
      [{ path: "src/index.ts", source: `import { createHarness } from "@orosus/core";\nimport { defineModule } from "@orosus/contracts/module";` }],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("@orosus/core");
    expect(violations[0]).toContain("src/index.ts");
  });

  it("测试文件 import core（devDep 合法用途）与包内相对 import → 不违规", () => {
    const violations = checkPackage(
      { name: "@orosus/tool-todo", orosus: { module: true }, dependencies: { "@orosus/contracts": "workspace:*" }, devDependencies: { "@orosus/core": "workspace:*" } },
      [
        { path: "src/index.test.ts", source: `import { createHarness } from "@orosus/core";` },
        { path: "src/backends/a.ts", source: `import { s } from "../search.ts";` },
        { path: "src/index.ts", source: `// import { x } from "@orosus/core";` },
      ],
    );
    expect(violations).toHaveLength(0);
  });

  it("相对 import 越出包目录（allowImportingTsExtensions 通道）→ 违规", () => {
    const violations = checkPackage(
      { name: "@orosus/tool-todo", orosus: { module: true }, dependencies: { "@orosus/contracts": "workspace:*" } },
      [{ path: "src/index.ts", source: `export { helper } from "../../core/src/kernel/index.ts";` }],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("越出包目录");
  });
});
