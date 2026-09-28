# home 域 API 参考

> 宿主数据目录解析（OROSUS_HOME 覆盖）。
> 本文件由 `scripts/gen-api-docs.mts` 从 contracts 源生成（`pnpm gen-docs`，docs:check 门禁验同步）——
> 注释、@param（含义+范围）、@example 与源码同源；发现缺口门禁会红。

## orosusHome（函数）

展开为用户主目录、分隔符与尾斜杠归一；不再拼接子目录；未设/空白 = ~/.orosus）。

```ts
export function orosusHome(env: NodeJS.ProcessEnv = process.env): string;
```

**参数**

| 名 | 说明 |
|---|---|
| `env` | 环境变量表（缺省 process.env；测试注入隔离表）。读 OROSUS_HOME，值先 trim——空白串视为未设。 |

**返回**：数据目录绝对路径（CT-03 修复：env 值 trim 后 resolve 归一——相对路径按进程 cwd 固化、开头的 ~
