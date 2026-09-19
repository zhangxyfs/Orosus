import { describe, it, expect } from "vitest";
import { psCommandFor, isMeaningfulImage, imagesFor } from "./paste.ts";

describe("图片粘贴（M4-2 T10；M4-2.5 T5 升真实附着）", () => {
  it("① psCommandFor + isMeaningfulImage——PS 参数正确；≤100 字节无效（空文件防御）", () => {
    const args = psCommandFor("C:\\Users\\x\\.orosus\\tmp\\paste-1.png");
    expect(args.join(" ")).toContain("Get-Clipboard -Format Image");
    expect(args.join(" ")).toContain("C:/Users/x/.orosus/tmp/paste-1.png"); // 反斜杠转正斜杠（PS 引号转义歧义防御）
    expect(isMeaningfulImage(99)).toBe(false);
    expect(isMeaningfulImage(10)).toBe(false);
    expect(isMeaningfulImage(4096)).toBe(true);
  });

  it("② imagesFor——pendingImage 构造 prompt images opts；无图 undefined（M4-2.5 T5 装配锚，1:1 换 withImageRef 例）", () => {
    expect(imagesFor("/x/.orosus/tmp/paste-1.png")).toEqual({ images: ["/x/.orosus/tmp/paste-1.png"] });
    expect(imagesFor(undefined)).toBeUndefined();
  });
});
