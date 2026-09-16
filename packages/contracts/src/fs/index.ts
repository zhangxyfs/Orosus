/** fs 能力 key——公共短名只能由 contracts 定义（规则 1）。提供者如 tool-fs；消费者 dependsOn: ["fs"]。 */
export const FS = "fs" as const;

/** 本地文件系统能力契约。换实现（本地 → 沙箱）时消费者零改动。 */
export interface Fs {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}
