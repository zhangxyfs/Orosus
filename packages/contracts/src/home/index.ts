import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Orosus 数据目录单一解析点（M4-2.5 T6）：OROSUS_HOME env > ~/.orosus（v17 平台注记同源）。
 *  落 contracts（铁律 2）——core/模块/CLI 三侧散落拼接全量收拢到此；空串视为未设。
 *  迁移语义见 CLI `home migrate`（缺省 dry-run、双侧校验、源留证改名绝不删）。 */
/**
 * @param env - 环境变量表（缺省 process.env；测试注入隔离表）。读 OROSUS_HOME，值先 trim——空白串视为未设。
 * @returns 数据目录绝对路径（CT-03 修复：env 值 trim 后 resolve 归一——相对路径按进程 cwd 固化、开头的 ~
 *  展开为用户主目录、分隔符与尾斜杠归一；不再拼接子目录；未设/空白 = ~/.orosus）。
 */
export function orosusHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env["OROSUS_HOME"]?.trim(); // CT-03：先 trim——原实现对纯空白串 " " 会当合法值原样返回
  if (v === undefined || v === "") return join(homedir(), ".orosus");
  // CT-03：JSDoc 承诺绝对路径——resolve 固化相对路径（下游 join 消费，原样返回会随进程 cwd 漂移读到不同
  // 的 config/secrets）；开头的 ~ 兜底展开（shell 通常已展开，这里挡未展开形态，避免 resolve 成 <cwd>/~）
  const p = v === "~" || v.startsWith("~/") || v.startsWith("~\\") ? join(homedir(), v.slice(1)) : v;
  return resolve(p);
}
