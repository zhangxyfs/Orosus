import { describe, it, expect } from "vitest";
import { encodeCwd } from "./dir.ts";

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
