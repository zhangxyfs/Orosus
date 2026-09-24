/** @orosus/core 公开出口（§9：单一出口，面向 apps 与嵌入式宿主；模块不 import 本包——铁律 2）。 */
export { createHarness, type Harness, type HarnessOptions } from "./harness.ts";
export type { ModuleGraph } from "./kernel/kernel.ts";
export type { ReloadReport, GraphDef } from "./kernel/reload.ts";
export type { PreservedInstance } from "./kernel/activate.ts";
export type { AuditEntry, ModuleRecord, ModuleState } from "./kernel/types.ts";
export { InMemorySessionStore } from "./session/memory.ts";
export { JsonlSessionStore, hardeningNote } from "./session/jsonl.ts";
export { SqliteSessionStore, sqliteAvailable } from "./session/sqlite.ts";
export type { SessionEvent, SessionStore } from "./session/types.ts";
export { encodeCwd, scanSessionFiles, locateSessionFile } from "./session/dir.ts";
export type { SessionFileEntry } from "./session/dir.ts";
export { deriveMessages } from "./loop/convert.ts"; // 宿主面（M4-1 T6 复核用）：日志投影 → 模型消息
export { verifyChain } from "./session/fork.ts"; // 宿主面（M4-1 T6 复核用）：复合投影链校验
export { repairFile } from "./session/jsonl.ts"; // 宿主面（M4-1 T6 复核用）：撕裂尾修复
export { loadTrustStore, saveTrustStore, checkTrust, trustModule, normalizeTrustKey, type TrustStore } from "./kernel/trust.ts";
// 宿主面（§9）：CLI module 子命令族的发现数据源——与 trust 函数同批先例（M2 补账：T13 处理器从未接线）
export { discoverModules, type DiscoveredModule } from "./kernel/discover.ts";
// M4-3 T1d 宿主面：引导期按裸条目实拉模型清单需直读 secrets（reload 前的文件级解析）
export { loadSecretsEnv } from "./config/load.ts";
