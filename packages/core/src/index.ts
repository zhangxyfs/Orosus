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
export { encodeCwd, scanSessionFiles, scanBucketSessions, locateSessionFile } from "./session/dir.ts";
export type { SessionFileEntry } from "./session/dir.ts";
// 会话树批 T7：树快照统一件（宿主列表 readTitle 薄封装同源）——预算读件与树构建落 core
export { buildSessionTree, readSessionHead, isEmptySessionHead, type SessionHead } from "./session/tree.ts";
// 空会话清理批（2026-10-01 用户拍板）：退出漏斗就地清 + 启动清扫异常退出残留壳（宿主 CLI 两调用点）
export { purgeSessionDir, sweepEmptySessions, type EmptySessionSweep } from "./session/cleanup.ts";
// m5-collab T0：live.json 活体心跳纯函数件——/ps、协同卡、多开提示的统一事实源（宿主侧读写口）
export { isLive, readLiveFile, writeLiveFile, removeLiveFile, LIVE_FILE, type LiveInfo, type LiveRecord } from "./session/live.ts";
export { deriveMessages } from "./loop/convert.ts"; // 宿主面（M4-1 T6 复核用）：日志投影 → 模型消息
export { verifyChain } from "./session/fork.ts"; // 宿主面（M4-1 T6 复核用）：复合投影链校验
export { repairFile } from "./session/jsonl.ts"; // 宿主面（M4-1 T6 复核用）：撕裂尾修复
export { appendInput, readInputs } from "./session/inputs.ts"; // T13（m5-resume-perf）：输入召回 sidecar——CLI 提交层写/装载层读
export { refreshEventIndex, defaultEventIndexFile } from "./session/eventindex.ts"; // D14 ②③（m5-resume-perf）：列表时机后台全库补建 + 缺省库位单一解析点——CLI 列表接线
export { loadTrustStore, saveTrustStore, checkTrust, trustModule, normalizeTrustKey, atomicWriteTextSync, type TrustStore } from "./kernel/trust.ts"; // atomicWriteTextSync：m5-hooks T10 钩子信任面写盘（tmp+rename 原子替换——CK-07 修复成果件复用）
// 宿主面（§9）：CLI module 子命令族的发现数据源——与 trust 函数同批先例（M2 补账：T13 处理器从未接线）
export { discoverModules, type DiscoveredModule } from "./kernel/discover.ts";
// M4-3 T1d 宿主面：引导期按裸条目实拉模型清单需直读 secrets（reload 前的文件级解析）
export { loadSecretsEnv, loadConfig, modelsDevCacheFile, lookupModelsDevContextWindow, resolveContextWindow } from "./config/load.ts"; // loadConfig 导出（m4-8 T2.5 散读收口）；窗口链三件（2026-09-29：config 显式 > models-dev 目录兜底）
export { writeSectionKey, sectionPath, writeNestedTable, type NestedTableValue } from "./config/write.ts"; // 统一写口导出（m4-8 T3——写配置单一事实源；T13 嵌套表写入器）
