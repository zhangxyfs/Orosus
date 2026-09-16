/** @orosus/core 公开出口（§9：单一出口，面向 apps 与嵌入式宿主；模块不 import 本包——铁律 2）。 */
export { createHarness, type Harness, type HarnessOptions } from "./harness.ts";
export type { ModuleGraph } from "./kernel/kernel.ts";
export type { AuditEntry, ModuleRecord, ModuleState } from "./kernel/types.ts";
export { InMemorySessionStore } from "./session/memory.ts";
export { JsonlSessionStore, hardeningNote } from "./session/jsonl.ts";
export type { SessionEvent, SessionStore } from "./session/types.ts";
