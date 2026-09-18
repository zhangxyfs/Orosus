import type { CommandHandler, CapabilityKey, CommandUi, Disposer, Listener, LlmPort, ModuleContext, ModuleDefinition, PromptSection } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import type { ProviderAdapter, StreamFn } from "@orosus/contracts/provider";
import { createLogger, type DiagSink } from "../diag/logger.ts";
import type { SessionStore } from "../session/types.ts";
import { CORE_BUS_TYPES, type EventBus } from "./bus.ts";
import type { ToolRegistry } from "../tool/registry.ts";
import type { SectionResolution } from "../config/validate.ts";
import { CORE_RESERVED_SLOT_KEYS, CORE_RESERVED_SLOT_PREFIXES } from "./validate.ts";
import type { ModuleRecord } from "./types.ts";

export const PROMPT_SECTION_LIMIT = 32768;  // 单段 32KB（§6.5）
export const PROMPT_TOTAL_LIMIT = 65536;    // 全局 64KB

/** llm 口的持有器（D39）：harness 在 loadModules 后写入实现——activate 期调用只得带内错误（惰性注入）。 */
export interface LlmHolder {
  impl?: LlmPort;
}

const unassignedLlm: LlmPort = {
  stream: () => (async function* () {
    yield { type: "finish", kind: "error", errorMessage: "llm 口未注入（harness 未装配——activate 期调用过早，D39）" };
  })(),
};

/** 无头缺省交互 UI（D35 fail-closed）：三方法抛"无交互环境"——waterfall 监听者抛错即否决。 */
const rejectingUi = (): CommandUi => ({
  ask: async () => { throw new Error("无交互环境（headless）——交互不可用（D35 fail-closed）"); },
  choose: async () => { throw new Error("无交互环境（headless）——交互不可用（D35 fail-closed）"); },
  confirm: async () => { throw new Error("无交互环境（headless）——交互不可用（D35 fail-closed）"); },
});

export interface ServiceResolver {
  get(key: string): Promise<unknown>;
  getOptional(key: string): Promise<unknown | undefined>;
  /** 枚举 provider 槽（/model 等内建命令的消费面，D38）——归一化形态。 */
  listProviders(): { name: string; defaultModel?: string }[];
  /** 槽值 ProviderAdapter 经归一化后的形态（函数 → { stream }，缺 defaultModel）——消费侧免判形状（D32；模型发现修订：透传 listModels 尽力能力） */
  provider(name: string): { stream: StreamFn; defaultModel?: string; listModels?: () => Promise<string[]> } | undefined;
}

export interface ActivateInput {
  ordered: ModuleDefinition[];
  sectionResolution: SectionResolution;
  session: SessionStore;
  sink: DiagSink;
  bus: EventBus;
  tools: ToolRegistry;
  commandUi?: CommandUi;                        // 宿主交互 UI（D35 M3/T2：ctx.ui——审批询问等 waterfall 侧消费）
  llm?: LlmHolder;                              // 二级模型口持有器（D39/T4）：harness 装配后写入，运行期读取
  preserved?: Map<string, PreservedInstance>;   // reload 用：Unchanged 模块跳过 activate，沿用句柄与代际（§5.5）
  generations?: Map<string, number>;            // reload 用：旧代际基线——重新激活者 +1（§5.5 代际按模块实例计）
}

/** reload 保留实例（§5.5 Unchanged）：kernel 侧从旧图收集（preservable()），新图直接沿用。 */
export interface PreservedInstance {
  def: ModuleDefinition;
  generation: number;
  services: { key: string; impl: unknown }[];  // 带 impl——新图 services 表重建需要实现值
  commands: { name: string; handler: CommandHandler; owner: string }[];
  promptSections: { order: number; text: string; owner: string }[];
  disposeFn?: Disposer;                        // 旧实例的模块 dispose（后续 teardown 调用）
  record: ModuleRecord;                        // 原记录（generation 不变）
}

export interface ActivateOutput {
  records: ModuleRecord[];
  services: ServiceResolver;
  commands: { name: string; handler: CommandHandler; owner: string }[];
  promptSections: { order: number; text: string; owner: string }[];
  contributes: Map<string, string[]>;
  rollbackModule(name: string): Promise<void>;
  disposeAll(): Promise<void>;

  preservable(): Map<string, PreservedInstance>;
}

interface Stage {
  services: { key: string; impl: unknown }[];
  tools: Tool[];
  commands: { name: string; handler: CommandHandler }[];
  promptSections: PromptSection[];
  listeners: { type: string; listener: Listener }[];

  overlays: { section: string; read(value: unknown): unknown; owner: string }[];
}

interface OwnerContribs {
  serviceKeys: string[];
  disposers: Disposer[];
  disposeFn?: Disposer;
}

const isReservedSlot = (key: string): boolean =>
  CORE_RESERVED_SLOT_KEYS.includes(key as never) || CORE_RESERVED_SLOT_PREFIXES.some((p) => key.startsWith(p));

/** §4.2 第 6 步：依拓扑序激活。staged commit；失败回滚 pending 并级联降级硬依赖消费者（§10）。mounts 声明校验：注册口/事件超出声明即抛（§5.1）。 */
export async function activateModules(input: ActivateInput): Promise<ActivateOutput> {
  const { sectionResolution, session, sink, bus, tools } = input;
  const klog = createLogger(sink, "kernel");
  const records: ModuleRecord[] = [];
  const failed = new Map<string, string>();
  const committedServices = new Map<string, { impl: unknown; owner: string }>();
  const ownerContribs = new Map<string, OwnerContribs>();
  const committedCommands: ActivateOutput["commands"] = [];
  const committedSections: ActivateOutput["promptSections"] = [];
  const contributes = new Map<string, string[]>();
  const activeNames: string[] = []; // 激活序（dispose 时倒序）
  const committedOverlays: { section: string; read(value: unknown): unknown; owner: string }[] = []; // 注册序 = 激活拓扑序（§6.6）

  const staledModules = new Set<string>(); // 换下实例标记：其 ctx.services.get 抛 stale（§5.5）

  const rollbackModule = async (name: string): Promise<void> => {
    staledModules.add(name);
    const c = ownerContribs.get(name);
    if (!c) return;
    ownerContribs.delete(name);
    contributes.delete(name); // 审计不展示模块已不持有的贡献
    // 回滚顺序（§5.2 规则 3）：先调模块 dispose()（注册之外的清理），再按注册逆序调各 disposer
    if (c.disposeFn) {
      try { await c.disposeFn(); } catch (err) { klog.error("kernel.dispose.error", "dispose 抛错被记录", { module: name, error: String(err) }); }
    }
    for (const key of c.serviceKeys) committedServices.delete(key);
    for (const d of [...c.disposers].reverse()) {
      try { await d(); } catch (err) { klog.error("kernel.dispose.error", "disposer 抛错被记录", { module: name, error: String(err) }); }
    }
    for (const arr of [committedCommands, committedSections] as const) {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.owner === name) arr.splice(i, 1);
    }
    const idx = activeNames.indexOf(name);
    if (idx >= 0) activeNames.splice(idx, 1);
  };

  const fail = (def: ModuleDefinition, reason: string): void => {
    failed.set(def.name, reason);
    records.push({ def, name: def.name, source: "inline", state: "failed", failReason: reason, generation: (input.generations?.get(def.name) ?? 0) + 1 });
    klog.warn("kernel.module.failed", `模块降级：${reason}`, { module: def.name });
  };

  for (const def of input.ordered) {
    const preservedThis = input.preserved?.get(def.name);
    if (preservedThis !== undefined && preservedThis.def === def) {
      // Unchanged（§5.5）：不重跑 activate，沿用旧实例的句柄与代际；贡献重登记进本图产出
      for (const { key, impl } of preservedThis.services) committedServices.set(key, { impl, owner: def.name });
      committedCommands.push(...preservedThis.commands);
      committedSections.push(...preservedThis.promptSections);
      ownerContribs.set(def.name, { serviceKeys: preservedThis.services.map((x) => x.key), disposers: [], ...(preservedThis.disposeFn !== undefined ? { disposeFn: preservedThis.disposeFn } : {}) });
      contributes.set(def.name, ["(unchanged，句柄沿用)"]);
      activeNames.push(def.name);
      records.push({ ...preservedThis.record, state: "active" });
      continue;
    }
    // 级联：硬依赖能力未入册 → 预降级不激活。理由必须诚实区分两种情形（审计带完整链，§10）：
    // 提供者已失败 → 级联；提供者 active 但没 provide 该 key → 提供者模块 bug
    const missingKey = (def.dependsOn ?? [])
      .filter((d): d is string => typeof d === "string")
      .find((key) => !committedServices.has(key));
    if (missingKey !== undefined) {
      const failedOwner = records.find((r) => r.state === "failed" && (r.def.provides ?? []).includes(missingKey));
      fail(
        def,
        failedOwner !== undefined
          ? `硬依赖能力 "${missingKey}" 的提供者 ${failedOwner.name} 已降级（级联降级）`
          : `硬依赖能力 "${missingKey}" 未注册：其提供者已激活但未 provide（提供者模块 bug）`,
      );
      continue;
    }

    // 配置校验（schema 不过 = 该模块降级，§4.2 第 6 步）
    const cfg = sectionResolution.configFor(def);
    if (!cfg.ok) {
      fail(def, `配置校验失败：${cfg.error}`);
      continue;
    }

    const stage: Stage = { services: [], tools: [], commands: [], promptSections: [], listeners: [], overlays: [] };
    const moduleState = { activated: false }; // activate 返回且 commit 后置 true——configRead 据此区分 activate 期（纯分层值，v13）
    const mlog = createLogger(sink, def.name);
    const allows = (m: string): boolean => def.mounts === undefined || def.mounts.includes(m); // mounts 缺省 = 不限制；一经声明 = 白名单（§5.1），未列出的口注册即抛

    const ctx: ModuleContext<unknown> = {
      config: cfg.value,
      configRead: async () => {
        if (!moduleState.activated) return cfg.value; // activate 期 = 纯分层合并值（v13 定案）
        let value: unknown = cfg.value;
        for (const ov of committedOverlays) { // 注册序 = 激活拓扑序复合（§6.6）
          if (ov.section !== def.name) continue;
          try {
            const r = await ov.read(value);
            if (r !== undefined) value = r;
          } catch (err) {
            throw new Error(`overlay（${ov.owner}）读取抛错：${String(err instanceof Error ? err.message : err)}`);
          }
        }
        if (def.config !== undefined) { // owner schema 复检（§6.6：不过则该次读取返回错误，不影响图）
          const parsed = def.config.safeParse(value);
          if (!parsed.success) {
            throw new Error(`配置运行期读取校验失败（overlay 改写值未过 schema 复检，§10）：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
          }
          return parsed.data;
        }
        return value;
      },
      log: mlog,
      ui: input.commandUi ?? rejectingUi(),
      llm: {
        stream: (req) => (input.llm?.impl ?? unassignedLlm).stream(req), // 惰性读取——reload 共用同一 holder 时旧闭包亦指向新实现
        get contextWindow() { return (input.llm?.impl ?? unassignedLlm).contextWindow; }, // 补强 T3：同款惰性转发——只转发 stream 透不出只读字段（首轮 P0）
        get lastUsage() { return (input.llm?.impl ?? unassignedLlm).lastUsage; },
      },
      services: {
        get: (<T>(key: CapabilityKey<T>) => {
          if (staledModules.has(def.name)) throw new Error(`句柄已过期（模块 "${def.name}" 已在 reload 中停用，stale——§5.5）`);
          const s = committedServices.get(key as string);
          if (!s) throw new Error(`能力 "${String(key)}" 无可用提供者（提供者缺失/已降级）`);
          return Promise.resolve(s.impl as T);
        }),
        getOptional: (<T>(key: CapabilityKey<T>) => Promise.resolve(committedServices.get(key as string)?.impl as T | undefined)),
      },
      provide: (key, impl) => {
        if (!allows("provide")) throw new Error(`mounts 校验：provide 未在声明（§5.1）`);
        const declared = (def.provides ?? []).includes(key);
        if (!declared && !isReservedSlot(key)) {
          throw new Error(`provide 越界：key "${key}" 不在 provides 声明且非核心保留槽（§5.2 规则 1）`);
        }
        stage.services.push({ key, impl });
      },
      contribute: {
        configOverlay: (o) => {
          if (!allows("contribute:configOverlay")) throw new Error(`mounts 校验：contribute:configOverlay 未在声明（§5.1）`);
          const section = o.section ?? def.name;
          if (section !== def.name && !(def.uses ?? []).includes("config.foreign")) {
            throw new Error(`overlay 声明他人 section "${section}"——须在 uses 中声明 "config.foreign"（§6.6 访问边界）`);
          }
          const entry = { section, read: o.read, owner: def.name };
          stage.overlays.push(entry);
          return () => { // 真 disposer（测试①）：stage 与 committed 双侧摘除
            const si = stage.overlays.indexOf(entry);
            if (si >= 0) stage.overlays.splice(si, 1);
            const ci = committedOverlays.indexOf(entry);
            if (ci >= 0) committedOverlays.splice(ci, 1);
          };
        },
        tool: (t) => {
          if (!allows("contribute:tool")) throw new Error(`mounts 校验：contribute:tool 未在声明（§5.1）`);
          stage.tools.push(t); return () => { /* M1 已知限制：模块侧 disposer 为 no-op，注销由 kernel 侧 disposers 承担（rollback/disposeAll）；swap 式真 disposer 随 M2 reload 一并做 */ };
        },
        command: (name, handler) => {
          if (!allows("contribute:command")) throw new Error(`mounts 校验：contribute:command 未在声明（§5.1）`);
          stage.commands.push({ name, handler }); return () => { /* 同上：M1 no-op disposer */ };
        },
        promptSection: (s) => {
          if (!allows("contribute:promptSection")) throw new Error(`mounts 校验：contribute:promptSection 未在声明（§5.1）`);
          stage.promptSections.push(s); return () => { /* 同上：M1 no-op disposer */ };
        },
      },
      session: {
        append: (type, payload) => {
          if (!(def.logEvents ?? []).includes(type)) {
            throw new Error(`日志事件类型 "${type}" 未在 logEvents 声明（白名单，§5.1）`);
          }
          void session.append(type, payload).catch((err) => {
            // 码表纪律（§11.9）：核心码只用 kernel/loop/provider 前缀；经 klog 归核心，module 名放 data
            klog.error("kernel.session.append-error", "扩展事件落日志失败", { module: def.name, type, error: String(err) });
          });
        },
      },
      events: {
        on: (type, listener) => {
          if (!allows(`hook:${type}`)) throw new Error(`mounts 校验：hook:${type} 未在声明（§5.1）`);
          stage.listeners.push({ type, listener }); return () => { /* 同上：M1 no-op disposer */ };
        },
        emit: async (type, payload) => {
          if (!allows("emit")) throw new Error(`mounts 校验：emit 未在声明（§5.1）`);
          if (CORE_BUS_TYPES.has(type) || !type.startsWith(`${def.name}/`)) {
            klog.warn("kernel.emit.rejected", `模块 emit 被拒：${type}`, { module: def.name });
            throw new Error(`模块只能 emit 自有命名空间 "${def.name}/" 且不得伪造核心类型（§6.5）`);
          }
          await bus.emit(type, payload);
        },
      },
    };

    try {
      const result = await def.activate(ctx);

      // ---- commit（任一步失败 → 回滚本次已提交 + discard 其余）----
      const mine: OwnerContribs = { serviceKeys: [], disposers: [] };
      const myContributes: string[] = [];
      try {
        for (const { key, impl } of stage.services) {
          if (isReservedSlot(key) && committedServices.has(key)) {
            // 保留槽冲突（§7.2）：双方降级，先注册者停用回滚，无消费者级联
            const first = committedServices.get(key)!.owner;
            await rollbackModule(first);
            records.find((r) => r.name === first)!.state = "failed";
            records.find((r) => r.name === first)!.failReason = `保留槽 "${key}" 冲突（与 ${def.name}），双方降级`;
            throw new Error(`保留槽 "${key}" 与已激活模块 ${first} 冲突，双方降级`);
          }
          committedServices.set(key, { impl, owner: def.name });
          mine.serviceKeys.push(key);
          myContributes.push(`service: ${key}`);
        }
        for (const t of stage.tools) {
          mine.disposers.push(tools.register(t, def.name));
        }
        if (stage.tools.length > 0) myContributes.push(`tools: ${stage.tools.map((t) => t.name).join(", ")}`);
        for (const c of stage.commands) {
          if (!c.name.startsWith(`${def.name}__`)) throw new Error(`命令 "${c.name}" 未带 "${def.name}__" 前缀（规则 4）`);
          if (committedCommands.some((x) => x.name === c.name)) throw new Error(`命令重名：${c.name}`);
          committedCommands.push({ ...c, owner: def.name });
        }
        for (const s of stage.promptSections) {
          if (s.order <= -100) throw new Error(`promptSection order ${s.order} 侵入核心保留区（≤ -100 为 harness 身份段，§6.5）`);
          if (s.text.length > PROMPT_SECTION_LIMIT) throw new Error(`promptSection 单段超预算 32KB（§6.5）`);
          const total = committedSections.reduce((n, x) => n + x.text.length, 0) + s.text.length;
          if (total > PROMPT_TOTAL_LIMIT) throw new Error(`promptSection 全局超预算 64KB（§6.5）`);
          committedSections.push({ ...s, owner: def.name });
        }
        for (const l of stage.listeners) {
          mine.disposers.push(bus.on(l.type, l.listener, def.name));
        }
        for (const ov of stage.overlays) {
          committedOverlays.push(ov);
          const off = () => {
            const ci = committedOverlays.indexOf(ov);
            if (ci >= 0) committedOverlays.splice(ci, 1);
          };
          mine.disposers.push(off); // rollback/disposeAll 摘除
          myContributes.push(`overlay: ${ov.section === def.name ? "(own)" : ov.section}`);
        }
        if (stage.listeners.length > 0) myContributes.push(`hooks: ${stage.listeners.map((l) => l.type).join(", ")}`);
      } catch (commitErr) {
        // staged commit 语义（§8.4"任何一步失败，discard"）：services/tools/listeners 经 mine 回收；
        // commands/promptSections 是直接 push 进注册表的，必须按 owner 逐条拔除；
        // 模块 activate 已返回的 dispose 也要调——注册之外的资源（句柄/子进程）不能泄漏（规则 3）
        for (const key of mine.serviceKeys) committedServices.delete(key);
        for (const d of [...mine.disposers].reverse()) {
          try { await d(); } catch { /* 已记录于各处 */ }
        }
        for (const arr of [committedCommands, committedSections] as const) {
          for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.owner === def.name) arr.splice(i, 1);
        }
        if (result && typeof result === "object" && "dispose" in result && typeof result.dispose === "function") {
          try { await (result as { dispose: Disposer }).dispose(); } catch { /* 同上：不中断回滚 */ }
        }
        throw commitErr;
      }

      if (result && typeof result === "object" && "dispose" in result && typeof result.dispose === "function") {
        mine.disposeFn = result.dispose;
      }
      if (def.config) myContributes.push(`config: [${def.name}]`);
      ownerContribs.set(def.name, mine);
      contributes.set(def.name, myContributes);
      activeNames.push(def.name);
      moduleState.activated = true; // 运行期 configRead 开始应用 overlay
      records.push({ def, name: def.name, source: "inline", state: "active", generation: (input.generations?.get(def.name) ?? 0) + 1 });
      klog.info("kernel.module.active", "模块激活", { module: def.name });
    } catch (err) {
      fail(def, String(err instanceof Error ? err.message : err));
    }
  }

  const services: ServiceResolver = {
    get: (key) => {
      const s = committedServices.get(key);
      if (!s) return Promise.reject(new Error(`能力 "${key}" 无可用提供者`));
      return Promise.resolve(s.impl);
    },
    getOptional: (key) => Promise.resolve(committedServices.get(key)?.impl),
    listProviders: () =>
      [...committedServices.keys()]
        .filter((k) => k.startsWith("provider:"))
        .map((k) => {
          const impl = committedServices.get(k)!.impl as ProviderAdapter;
          return typeof impl === "function" ? { name: k.slice(9) } : { name: k.slice(9), ...(impl.defaultModel !== undefined ? { defaultModel: impl.defaultModel } : {}) };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    provider: (name) => {
      const impl = committedServices.get(`provider:${name}`)?.impl as ProviderAdapter | undefined;
      if (impl === undefined) return undefined;
      return typeof impl === "function" ? { stream: impl } : impl; // 对象形整体透传——listModels 随槽值（模型发现 T3）
    },
  };

  return {
    records,
    services,
    commands: committedCommands,
    promptSections: committedSections,
    contributes,
    rollbackModule,
    /** 旧图 → PreservedInstance 收集口（reload 的 Unchanged 沿用数据源，§5.5）。 */
    preservable: () => {
      const out = new Map<string, PreservedInstance>();
      for (const name of activeNames) {
        const rec = records.find((r) => r.name === name && r.state === "active");
        if (rec === undefined) continue;
        const c = ownerContribs.get(name);
        out.set(name, {
          def: rec.def,
          generation: rec.generation,
          services: (c?.serviceKeys ?? []).map((key) => ({ key, impl: committedServices.get(key)!.impl })),
          commands: committedCommands.filter((x) => x.owner === name),
          promptSections: committedSections.filter((x) => x.owner === name),
          ...(c?.disposeFn !== undefined ? { disposeFn: c.disposeFn } : {}),
          record: rec,
        });
      }
      return out;
    },
    disposeAll: async () => {
      for (const name of [...activeNames].reverse()) {
        await rollbackModule(name);
        const rec = records.find((r) => r.name === name && r.state === "active");
        if (rec) rec.state = "disposed"; // 审计可信：停用后 records 不再谎报 active
      }
    },
  };
}
