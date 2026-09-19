import { describe, it, expect } from "vitest";
import { psCommandFor, isMeaningfulImage, withImageRef } from "./paste.ts";

describe("图片粘贴（M4-2 T10）", () => {
  it("① psCommandFor + isMeaningfulImage——PS 参数正确；≤100 字节无效（空文件防御）", () => {
    const args = psCommandFor("C:\\Users\\x\\.orosus\\tmp\\paste-1.png");
    expect(args.join(" ")).toContain("Get-Clipboard -Format Image");
    expect(args.join(" ")).toContain("C:/Users/x/.orosus/tmp/paste-1.png"); // 反斜杠转正斜杠（PS 引号转义歧义防御）
    expect(isMeaningfulImage(99)).toBe(false);
    expect(isMeaningfulImage(10)).toBe(false);
    expect(isMeaningfulImage(4096)).toBe(true);
  });

  it("② withImageRef——pendingImage 附着到下一条消息文本；无图原样", () => {
    expect(withImageRef("这是什么？", "/x/.orosus/tmp/paste-1.png"))
      .toBe("这是什么？\n[图片: /x/.orosus/tmp/paste-1.png]");
    expect(withImageRef("普通消息", undefined)).toBe("普通消息");
  });
});
