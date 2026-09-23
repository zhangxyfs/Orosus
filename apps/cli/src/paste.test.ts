import { describe, it, expect } from "vitest";
import { psCommandFor, isMeaningfulImage, imagesFor, extractImageRefs } from "./paste.ts";

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
    expect(imagesFor(["/x/.orosus/tmp/paste-1.png"])).toEqual({ images: ["/x/.orosus/tmp/paste-1.png"] });
    expect(imagesFor([])).toBeUndefined();
  });

  it("③ extractImageRefs——文内 chip token 按出现序提取去重、剥除后正文空白收敛（2026-09-23 走查拍板：chip 进输入框可删）", () => {
    const r = extractImageRefs("看下这张图 [image #1 (271×157)] 和这个 [image #2] 呢");
    expect(r.seqs).toEqual([1, 2]);
    expect(r.cleaned).toBe("看下这张图 和这个 呢");
    expect(extractImageRefs("[image #3][image #3]").seqs).toEqual([3]); // 同图重复引用去重
    expect(extractImageRefs("[image #1 残token").seqs).toEqual([]); // 改残不匹配 = 不挂图
    expect(extractImageRefs("纯文本")).toEqual({ cleaned: "纯文本", seqs: [] });
  });
});
