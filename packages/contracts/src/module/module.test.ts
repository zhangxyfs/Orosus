import { describe, it, expect } from "vitest";
import { defineModule, MODULE_API_VERSION } from "./index.ts";

describe("defineModule", () => {
  it("原样返回定义对象（声明式，不执行 activate）", () => {
    let activated = false;
    const def = defineModule({
      name: "tool-x",
      version: "0.1.0",
      description: "测试模块",
      api: MODULE_API_VERSION,
      activate() { activated = true; },
    });
    expect(def.name).toBe("tool-x");
    expect(def.defaultEnabled).toBeUndefined(); // 缺省语义由 kernel 解释，defineModule 不补默认值
    expect(activated).toBe(false);
  });

  it("MODULE_API_VERSION 恒为 1", () => {
    expect(MODULE_API_VERSION).toBe(1);
  });
});
