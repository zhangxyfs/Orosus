/** 开浏览器（web 批 T1，G11）：win `start ""`（空标题参——§4-9 Windows 纪律）/ darwin `open` /
 *  linux `xdg-open`。返回 boolean：失败不炸（URL 横幅的手动指路行已兜底）。--no-open 由 mod.ts
 *  解析跳过，本件无参形态。
 *  输出纪律：stdio ignore 全吞——spawn 输出的 GBK/latin1 编码问题在「不读」处消失。 */
import { spawn } from "node:child_process";

export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
        : process.platform === "darwin"
          ? spawn("open", [url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false)); // ENOENT（无 xdg-open 等）——不炸
      child.once("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
