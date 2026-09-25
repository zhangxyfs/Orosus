# fs 域 API 参考

> 文件系统能力契约（FS 能力槽的接口形状）。
> 本文件由 `scripts/gen-api-docs.mts` 从 contracts 源生成（`pnpm gen-docs`，docs:check 门禁验同步）——
> 注释、@param（含义+范围）、@example 与源码同源；发现缺口门禁会红。

## FS（常量）

fs 能力 key——公共短名只能由 contracts 定义（规则 1）。提供者如 tool-fs；消费者 dependsOn: ["fs"]。

```ts
export const FS = "fs" as const
```

## Fs（接口）

```ts
export interface Fs { … }
```

**成员**

| 名 | 形态 | 说明 |
|---|---|---|
| `read` | `read(path: string): Promise<string>` | 读文本文件全量。 |
| `write` | `write(path: string, content: string): Promise<void>` | 写文本文件（覆盖）。 |

**方法参数**

| 方法 | 参 | 说明 |
|---|---|---|
| `read` | `path` | 绝对路径（不存在/不可读 = reject，消费方自行接）。 |
| `write` | `path` | 绝对路径（目录不存在不自动建；写失败 = reject）。 |
| `write` | `content` | 全量内容（UTF-8、整体覆盖式——追加语义自己先 read）。 |

**示例**

```ts
const fs = await ctx.services.getOptional(FS);
if (fs === undefined) ctx.log.warn("my.fs-miss", "无 fs 能力，走降级路径");
else await fs.write("/tmp/a.txt", "hi");
```
