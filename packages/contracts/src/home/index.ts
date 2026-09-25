import { homedir } from "node:os";
import { join } from "node:path";

/** Orosus 数据目录单一解析点（M4-2.5 T6）：OROSUS_HOME env > ~/.orosus（v17 平台注记同源）。
 *  落 contracts（铁律 2）——core/模块/CLI 三侧散落拼接全量收拢到此；空串视为未设。
 *  迁移语义见 CLI `home migrate`（缺省 dry-run、双侧校验、源留证改名绝不删）。 */
/**
 * @param env - 环境变量表（缺省 process.env；测试注入隔离表）。读 OROSUS_HOME，空串视为未设。
 * @returns 数据目录绝对路径（env 值原样使用——不再拼接子目录；未设 = ~/.orosus）。
 */
export function orosusHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env["OROSUS_HOME"];
  return v !== undefined && v !== "" ? v : join(homedir(), ".orosus");
}
