/** fs 能力 key——公共短名只能由 contracts 定义（规则 1）。提供者如 tool-fs；消费者 dependsOn: ["fs"]。 */
export const FS = "fs" as const;

/** 本地文件系统能力契约。换实现（本地 → 沙箱）时消费者零改动。 */
/**
 * @example
 * ```ts
 * const fs = await ctx.services.getOptional(FS);
 * if (fs === undefined) ctx.log.warn("my.fs-miss", "无 fs 能力，走降级路径");
 * else await fs.write("/tmp/a.txt", "hi");
 * ```
 */
export interface Fs {
  /**
   * 读文本文件全量。
   * @param path - 绝对路径（不存在/不可读 = reject，消费方自行接）。
   */
  read(path: string): Promise<string>;
  /**
   * 写文本文件（覆盖）。
   * @param path - 绝对路径（目录不存在不自动建；写失败 = reject）。
   * @param content - 全量内容（UTF-8、整体覆盖式——追加语义自己先 read）。
   */
  write(path: string, content: string): Promise<void>;
}
