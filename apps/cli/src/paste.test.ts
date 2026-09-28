import { describe, it, expect } from "vitest";
import { psCommandFor, osascriptArgsFor, isMeaningfulImage, imagesFor, extractImageRefs } from "./paste.ts";

describe("图片粘贴（M4-2 T10；M4-2.5 T5 升真实附着）", () => {
  it("① psCommandFor + isMeaningfulImage——PS 参数正确；≤100 字节无效（空文件防御）", () => {
    const args = psCommandFor("C:\\Users\\x\\.orosus\\tmp\\paste-1.png");
    expect(args.join(" ")).toContain("Get-Clipboard -Format Image");
    expect(args.join(" ")).toContain("C:/Users/x/.orosus/tmp/paste-1.png"); // 反斜杠转正斜杠（PS 引号转义歧义防御）
    expect(isMeaningfulImage(99)).toBe(false);
    expect(isMeaningfulImage(10)).toBe(false);
    expect(isMeaningfulImage(4096)).toBe(true);
  });

  it("①a CR-08：psCommandFor 单引号转义（' → ''）——路径含撇号不越出 PS 单引号串；反斜杠照转正斜杠", () => {
    const args = psCommandFor("C:\\Users\\o'brien\\.orosus\\tmp\\paste-1.png");
    expect(args.join(" ")).toContain("C:/Users/o''brien/.orosus/tmp/paste-1.png"); // 成对双写 = PS 单引号串唯一转义
    expect(args.join(" ")).not.toContain("o'brien"); // 未转义形不再出现（旧实现只转反斜杠，' 即断出串外）
  });

  it("①b CR-08：osascriptArgsFor 走 on run argv——路径独立逐参传递，绝不进 AppleScript 脚本体（旧形 \"${tmp}\" 的 \" 与 \\ 零转义面前案）", () => {
    const nasty = "/Users/o'brien/a\"b\\c 粘贴.png"; // 撇号 + 双引号 + 反斜杠 + 非 ASCII 全齐
    const args = osascriptArgsFor(nasty);
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain("on run argv"); // 脚本体只含骨架
    expect(args[1]).toContain("(item 1 of argv)"); // 落点取参不取字面量
    expect(args[1]).not.toContain("/Users/"); // 路径不进脚本体（进了就是转义面回归）
    expect(args[2]).toBe(nasty); // 原样独立参数——execFile 逐参传递零转义
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

describe("剪贴板纯文本（m5 T11——设计空白 13 取证通过：Get-Clipboard 不带 -Format 即文本）", () => {
	it("① 归一：剥一个尾换行、空串 = undefined", async () => {
		const { normalizeClipboardText } = await import("./paste.ts");
		expect(normalizeClipboardText("hello\r\n")).toBe("hello");
		expect(normalizeClipboardText("hello")).toBe("hello");
		expect(normalizeClipboardText("")).toBeUndefined();
		expect(normalizeClipboardText("\r\n")).toBeUndefined();
	});

	it("② 读取烟测：真机剪贴板（有工具）返回 string | undefined 且不抛错", async () => {
		const { readClipboardText } = await import("./paste.ts");
		await expect(readClipboardText()).resolves.not.toThrow;
		const r = await readClipboardText();
		expect(typeof r === "string" || r === undefined).toBe(true);
	});
});

describe("剪贴板纯文本写入（m5 鼠标批 T5——选择松开即复制）", () => {
	it("① clipboardWriteCommand 三平台：win 走 stdin 且前置 InputEncoding=UTF8（PS5 按系统 GBK 解 stdin 是复制乱码根因）、mac pbcopy、linux xclip→wl-copy 兜底链", async () => {
		const { clipboardWriteCommand } = await import("./paste.ts");
		const win = clipboardWriteCommand("win32");
		expect(win.file).toBe("powershell");
		const winCmd = win.args.join(" ");
		expect(winCmd).toContain("$input | Set-Clipboard"); // 文本走 stdin 不进命令行
		expect(winCmd).toContain("[Console]::InputEncoding"); // stdin 解码显式 UTF-8（2026-09-27 走查：粘贴出「锘挎」乱码 = UTF-8 被按 GBK 解）
		const mac = clipboardWriteCommand("darwin");
		expect(mac.file).toBe("pbcopy");
		expect(mac.args).toEqual([]);
		const linux = clipboardWriteCommand("linux");
		expect(linux.file).toBe("sh");
		expect(linux.args.join(" ")).toContain("xclip -selection clipboard");
		expect(linux.args.join(" ")).toContain("wl-copy"); // 无 xclip 时兜底
	});
	it("② openUrlCommand 三平台（m5 鼠标批 T7——设计空白 13）：win cmd /c start、mac open、linux xdg-open；openUrl 非 http 方案拒开返回 false", async () => {
		const { openUrlCommand, openUrl } = await import("./paste.ts");
		expect(openUrlCommand("win32", "https://x.com")).toEqual({ file: "cmd", args: ["/c", "start", "", "https://x.com"] });
		expect(openUrlCommand("darwin", "https://x.com")).toEqual({ file: "open", args: ["https://x.com"] });
		expect(openUrlCommand("linux", "https://x.com")).toEqual({ file: "xdg-open", args: ["https://x.com"] });
		await expect(openUrl("file:///etc/passwd")).resolves.toBe(false); // 注入面防线：链接来自模型输出
		await expect(openUrl("ftp://x.com")).resolves.toBe(false);
	});
});
