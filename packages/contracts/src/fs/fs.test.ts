import { describe, it, expect } from "vitest";
import { FS } from "./index.ts";

describe("fs 能力契约（规则 1）", () => {
  it("公共短名 fs 由 contracts 拥有", () => {
    expect(FS).toBe("fs");
  });
});
