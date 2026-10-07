/** 首次使用引导弹窗（M4-3 T1d，D10——推翻 M4-2「空配置直进主窗」旧拍板）：
 *  施工基准 = docs/prototypes/orosus-onboarding-prototype.html（布局/文案/键位以原型为准，全局约束 9）。
 *  三页定高锁焦点：欢迎（Ctrl + Q 退出 / Ctrl + N 下一步）→ 选择提供商（可配多家、Space 设当前使用、
 *  输入态 ↑↓ 换行草稿按行保留）→ 配置网络搜索（LLM 默认零配置 / 跨提供商钉模型 / Tavily / Brave）。
 *  2026-10-02 用户拍板：ollama 与「本地服务免 Key」整体移除——从未是产品设计（原型该部分退役，
 *  第 1 页 feat 文案同步去掉 Ollama；提供商标签 [本地]/[在线] 与 keyP2 本地分支随之拆除）。
 *  Ctrl + N 统一「下一步/完成」；Ctrl + C 全程不占用；Esc 不占用；Ctrl + Q 仅第 1 页（SW-22）。
 *  实机 Key 输入 = 静默盲输（SW-23：多层终端栈下逐键掩码回显碎成孤星——只显「已输入 N 字符」）。 */

import * as theme from "../theme.ts";
import { isPrintable } from "./keymatch.ts";
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from "./width.ts";
import { t } from "../i18n/app.ts";

export interface OnboardingProvider {
  id: string;
  name: string;
  envKey?: string | undefined;
  baseUrl: string;
  type: "openai" | "anthropic";
}

export interface OnboardingDeps {
  providers: OnboardingProvider[];
  /** 增量写入一家提供商（[provider-custom.providers.<id>]；apiKey 形 = $ENV: 占位符）。 */
  writeProvider(p: { id: string; type: "openai" | "anthropic"; baseUrl: string; apiKey?: string }): void;
  appendSecret(envKey: string, value: string): void;
  /** provider = "<slot>" 顶层键（/model 写盘同落点）。 */
  setModel(slot: string): void;
  /** [tool-web] search 节写回（tool-web persistToolWebSearch 同形；model=undefined 删键）。 */
  writeSearch(patch: { backend?: string | undefined; model?: string | undefined; tavilyApiKey?: string | undefined; braveApiKey?: string | undefined }): void;
  /** 按 provider 实拉模型清单（SW-24：目录优选 + live 兜底；reject = 拉取失败 → 回退手动输入行）。 */
  listModels(slot: string): Promise<string[]>;
  /** [tool-media] visionModel 写回（F14 引导页——D12 三态 "off"|"auto"|"<槽/模型>"）。 */
  writeVision(value: string): void;
  /** 已配置槽的多模态模型清单（宿主逐槽查目录——遮蔽坑免疫；空 = 空态指路）。 */
  visionModels(): Promise<string[]>;
  /** T6d 第 5 页（m5-peers）：五源探测（宿主接 importers.detectSources；available=false = 未安装/0 条）。 */
  detectMemorySources(): { id: string; label: string; note: string; count: number; available: boolean }[];
  /** T6d 第 5 页：导入勾选源（organize = D20 模型整理开关——仅引导当次生效不落盘）。
   *  异步（organize 开启时含 llm 调用）；完成经 deps.finish 收尾。 */
  importMemory(sourceIds: string[], organize: boolean): Promise<{ imported: number; skipped: number; merged: number }>;
  /** 引导自动收尾口（T6d：异步导入完成时宿主注入 resolve；测试/无头可省——手按 Ctrl+N 完成）。 */
  finish?(outcome: OnboardingOutcome): void;
  /** 异步清单到达后的重绘请求（FullApp 挂接时强制注入自家调度——宿主直驱测试可省略）。 */
  requestRender?(): void;
}

export type OnboardingOutcome = { kind: "completed"; importResult?: { imported: number; skipped: number; merged: number } } | { kind: "quit" };

type NoticeKind = "ok" | "warn" | "err";
interface P2State {
  sel: number; pageIdx: number; mode: "list" | "key";
  drafts: Record<string, string>; configured: string[]; active: string | null;
  notice: string; noticeKind: NoticeKind;
  pageSize: number; // 列表页大小（渲染期按正文可用高度动态回写——键位翻页与渲染同源；初值 = 旧固定值）
}
type P3Stage = "opts" | "llm" | "provs" | "models" | "manual" | "key";
interface P3State {
  sel: number; stage: P3Stage; keyOpt: "tavily" | "brave" | null; provOpt: string | null;
  models: string[]; drafts: Record<string, string>; chosen: "llm" | "tavily" | "brave" | null; model: string | null;
  notice: string; noticeKind: NoticeKind;
}

/** F14 第 3 页 · 配置视觉模型（D12 三态 + 指定列表——恒定 5 行空槽留白防闪烁）。 */
interface PVState {
  sel: number; mode: "opts" | "list";
  models: string[]; loading: boolean;
  notice: string; noticeKind: NoticeKind;
}

/** T6d 第 5 页 · 从其他 agent 导入记忆（v3 走查二轮 + v5 整理开关 D20）。 */
interface PMState {
  sel: number; checked: Set<string>; organize: boolean;   // sel 0..sources.length = 源行；+1 = 整理开关行
  importing: boolean;
  done: boolean;   // 导入已尝试（成功或失败）——此后 Ctrl+N 直接完成不再重试
  importResult?: { imported: number; skipped: number; merged: number };
  sources: { id: string; label: string; note: string; count: number; available: boolean }[];
  notice: string; noticeKind: NoticeKind;
}

const PAGE_TITLES = [t("onboard.p1.title"), t("onboard.p2.title"), t("onboard.p3.title"), t("onboard.p4.title"), t("onboard.p5.title")];
const VISION_OPTS = [
  { id: "off", name: t("onboard.vision.off.name"), desc: t("onboard.vision.off.desc") },
  { id: "auto", name: t("onboard.vision.auto.name"), desc: t("onboard.vision.auto.desc") },
  { id: "pick", name: t("onboard.vision.pick.name"), desc: t("onboard.vision.pick.desc") },
] as const;
const VISION_LIST_ROWS = 5; // 恒定行数（原型走查③：不足补空槽——高度恒定防闪烁铁律）

const PAGE_SIZE = 8;
const WEB_OPTS = [
  { id: "llm", name: "LLM Web Search", desc: t("onboard.web.llm.desc") },
  { id: "tavily", name: "Tavily", desc: t("onboard.web.tavily.desc") },
  { id: "brave", name: "Brave", desc: t("onboard.web.brave.desc") },
] as const;
const ENV_NAME: Record<"tavily" | "brave", string> = { tavily: "TAVILY_API_KEY", brave: "BRAVE_API_KEY" };

export class OnboardingSession {
  private deps: OnboardingDeps;
  private page: 1 | 2 | 3 | 4 | 5 = 1;
  private p2: P2State;
  private p3: P3State;
  private pv: PVState;
  private pm: PMState;

  constructor(deps: OnboardingDeps, initial?: { configured?: string[]; active?: string | null }) {
    this.deps = deps;
    this.p2 = {
      sel: 0, pageIdx: 0, mode: "list", drafts: {},
      configured: [...(initial?.configured ?? [])], active: initial?.active ?? null,
      notice: "", noticeKind: "warn",
      pageSize: PAGE_SIZE,
    };
    this.p3 = {
      sel: 0, stage: "opts", keyOpt: null, provOpt: null, models: [], drafts: {},
      chosen: null, model: null, notice: "", noticeKind: "warn",
    };
    this.pv = { sel: 0, mode: "opts", models: [], loading: false, notice: "", noticeKind: "warn" };
    this.pm = { sel: 0, checked: new Set(), organize: false, importing: false, done: false, sources: deps.detectMemorySources(), notice: "", noticeKind: "warn" };
  }

  /** 测试探针。 */
  get stateRef(): { page: number; p2: P2State; p3: P3State; pv: PVState; pm: PMState } {
    return { page: this.page, p2: this.p2, p3: this.p3, pv: this.pv, pm: this.pm };
  }

  private provById(id: string): OnboardingProvider {
    return this.deps.providers.find((p) => p.id === id) ?? { id, name: id, baseUrl: "", type: "openai" };
  }
  private activeName(): string {
    return this.p2.active === null ? t("onboard.p2.unconfigured") : this.provById(this.p2.active).name;
  }

  /** 粘贴（bracketed paste 路由）：输入态下整段进草稿（API Key 的首要输入方式就是粘贴）。 */
  handlePaste(text: string): void {
    const clean = text.replace(/[\r\n]+/g, "");
    if (clean === "") return;
    if (this.page === 2 && this.p2.mode === "key") {
      const prov = this.deps.providers[this.p2.sel];
      if (prov !== undefined) this.p2.drafts[prov.id] = (this.p2.drafts[prov.id] ?? "") + clean;
    } else if (this.page === 3 && this.p3.stage === "key" && this.p3.keyOpt !== null) {
      this.p3.drafts[this.p3.keyOpt] = (this.p3.drafts[this.p3.keyOpt] ?? "") + clean;
    } else if (this.page === 3 && this.p3.stage === "manual") {
      this.p3.drafts["__manual"] = (this.p3.drafts["__manual"] ?? "") + clean;
    }
  }

  handleKey(key: string): OnboardingOutcome | undefined {
    // Ctrl + Q：仅第 1 页退出（SW-22）；第 2/3 页给提示行——误按不炸引导
    if (key === "ctrl+q") {
      if (this.page === 1) return { kind: "quit" };
      this.notice(t("onboard.ctrlq.onlyP1"), "warn");
      return undefined;
    }
    if (key === "escape") return undefined; // Esc 在引导中不占用（SW-22——留白，不绑任何语义）
    if (this.page === 1) {
      if (key === "ctrl+n") this.page = 2;
      return undefined;
    }
    if (this.page === 2) return this.keyP2(key);
    if (this.page === 3) return this.keyPV(key);
    if (this.page === 4) return this.keyP3(key);
    return this.keyPM(key);
  }

  private notice(text: string, kind: NoticeKind): void {
    if (this.page === 2) { this.p2.notice = text; this.p2.noticeKind = kind; }
    else if (this.page === 3) { this.pv.notice = text; this.pv.noticeKind = kind; }
    else if (this.page === 5) { this.pm.notice = text; this.pm.noticeKind = kind; }
    else { this.p3.notice = text; this.p3.noticeKind = kind; }
  }

  /* ── 第 2 页 · 选择提供商（可配多家，当前使用仅一家——SW-25） ── */
  private keyP2(key: string): OnboardingOutcome | undefined {
    const p = this.p2;
    const providers = this.deps.providers;
    if (key === " ") {
      // Space = 设为当前使用（输入态下同样可用——API Key 不含空格）
      const prov = providers[p.sel];
      if (prov === undefined) return undefined;
      if (p.configured.includes(prov.id)) {
        p.active = prov.id;
        this.deps.setModel(prov.id);
        this.notice(t("onboard.p2.setModelDone", { id: prov.id }), "ok");
      } else {
        this.notice(t("onboard.p2.keyFirst", { name: prov.name }), "warn");
      }
      return undefined;
    }
    if (key === "up" || key === "down") {
      // 列表态与输入态都可换行（草稿按行保留——SW-25）
      p.sel = Math.max(0, Math.min(providers.length - 1, p.sel + (key === "down" ? 1 : -1)));
      p.pageIdx = Math.floor(p.sel / p.pageSize);
      return undefined;
    }
    if (p.mode === "list") {
      const pages = Math.max(1, Math.ceil(providers.length / p.pageSize));
      if (key === "pageDown") { p.pageIdx = Math.min(pages - 1, p.pageIdx + 1); p.sel = p.pageIdx * p.pageSize; return undefined; }
      if (key === "pageUp") { p.pageIdx = Math.max(0, p.pageIdx - 1); p.sel = p.pageIdx * p.pageSize; return undefined; }
    }
    if (key === "enter") {
      const prov = providers[p.sel];
      if (prov === undefined) return undefined;
      if (p.mode === "list") {
        if (p.drafts[prov.id] === undefined) p.drafts[prov.id] = "";
        p.mode = "key";
        p.notice = "";
        return undefined;
      }
      const draft = (p.drafts[prov.id] ?? "").trim();
      if (draft === "") { this.notice(t("onboard.key.empty"), "warn"); return undefined; }
      const envKey = prov.envKey ?? `${prov.id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      this.deps.appendSecret(envKey, draft);
      if (!p.configured.includes(prov.id)) p.configured.push(prov.id);
      this.deps.writeProvider({ id: prov.id, type: prov.type, baseUrl: prov.baseUrl, apiKey: `$ENV:${envKey}` });
      p.drafts[prov.id] = "";
      if (p.active === null) {
        p.active = prov.id;
        this.deps.setModel(prov.id);
        this.notice(`${t("onboard.p2.keyWrittenActive", { envKey: envKey })}`, "ok");
      } else {
        this.notice(t("onboard.p2.keyWrittenBackup", { envKey, name: prov.name }), "ok");
      }
      return undefined;
    }
    if (p.mode === "key") {
      if (key === "backspace") {
        const prov = providers[p.sel];
        if (prov === undefined) return undefined;
        const draft = p.drafts[prov.id] ?? "";
        if (draft !== "") p.drafts[prov.id] = draft.slice(0, -1);
        else p.mode = "list"; // 空草稿时 Backspace 退出输入态（SW-25）
        return undefined;
      }
      if (key.length === 1 && isPrintable(key)) {
        const prov = providers[p.sel];
        if (prov !== undefined) p.drafts[prov.id] = (p.drafts[prov.id] ?? "") + key;
        return undefined;
      }
    }
    if (key === "ctrl+n") {
      if (p.active === null) { this.notice(t("onboard.p2.needOne"), "warn"); return undefined; }
      this.page = 3;
      return undefined;
    }
    return undefined;
  }

  /* ── 第 3 页 · 配置视觉模型（F14——D12 三态；可不选直接 Ctrl + N，默认不开启） ── */
  private keyPV(key: string): OnboardingOutcome | undefined {
    const p = this.pv;
    if (key === "up" || key === "down") {
      const n = p.mode === "opts" ? VISION_OPTS.length : Math.max(1, p.models.length);
      p.sel = Math.max(0, Math.min(n - 1, p.sel + (key === "down" ? 1 : -1)));
      return undefined;
    }
    if (key === "backspace" && p.mode === "list") { p.mode = "opts"; p.sel = 0; p.notice = ""; return undefined; }
    if (key === "enter") {
      if (p.mode === "opts") {
        const o = VISION_OPTS[p.sel];
        if (o === undefined) return undefined;
        if (o.id === "off") {
          this.deps.writeVision("off");
          this.notice(t("onboard.vision.offOk"), "ok");
        } else if (o.id === "auto") {
          this.deps.writeVision("auto");
          this.notice(t("onboard.vision.autoOk"), "ok");
        } else {
          p.mode = "list"; p.sel = 0; p.loading = true; p.models = []; p.notice = "";
          this.deps.visionModels().then((models) => {
            if (p.mode !== "list") return; // 用户已返回选项页
            p.models = models; p.loading = false;
            if (models.length === 0) this.notice(t("onboard.vision.noModels"), "warn");
            this.deps.requestRender?.();
          }).catch(() => {
            if (p.mode !== "list") return;
            p.loading = false;
            this.notice(t("onboard.vision.listFail"), "warn");
            this.deps.requestRender?.();
          });
        }
        return undefined;
      }
      const m = p.models[p.sel];
      if (m !== undefined) {
        this.deps.writeVision(m);
        this.notice(t("onboard.vision.picked", { model: m }), "ok");
      }
      return undefined;
    }
    if (key === "ctrl+n") { this.page = 4; return undefined; }
    return undefined;
  }

  /* ── 第 4 页 · 配置网络搜索 ── */
  private keyP3(key: string): OnboardingOutcome | undefined {
    const p = this.p3;
    if (key === "backspace") {
      // 逐级返回（SW-24）：key 空草稿→opts；models/manual→provs；provs→llm；llm→opts
      if (p.stage === "key" && p.keyOpt !== null) {
        const draft = p.drafts[p.keyOpt] ?? "";
        if (draft !== "") p.drafts[p.keyOpt] = draft.slice(0, -1);
        else { p.stage = "opts"; p.notice = ""; }
        return undefined;
      }
      if (p.stage === "manual") {
        const draft = p.drafts["__manual"] ?? "";
        if (draft !== "") { p.drafts["__manual"] = draft.slice(0, -1); return undefined; }
        p.stage = "provs"; p.notice = ""; return undefined;
      }
      if (p.stage === "models") { p.stage = "provs"; p.sel = 0; p.notice = ""; return undefined; }
      if (p.stage === "provs") { p.stage = "llm"; p.sel = 0; p.notice = ""; return undefined; }
      if (p.stage === "llm") { p.stage = "opts"; p.sel = 0; p.notice = ""; return undefined; }
      return undefined;
    }
    if (p.stage === "opts") {
      if (key === "up" || key === "down") { p.sel = Math.max(0, Math.min(WEB_OPTS.length - 1, p.sel + (key === "down" ? 1 : -1))); return undefined; }
      if (key === "enter") {
        const o = WEB_OPTS[p.sel];
        if (o === undefined) return undefined;
        if (o.id === "llm") { p.stage = "llm"; p.sel = 0; p.notice = ""; }
        else { p.stage = "key"; p.keyOpt = o.id; p.notice = ""; }
        return undefined;
      }
    } else if (p.stage === "llm") {
      if (key === "up" || key === "down") { p.sel = 1 - p.sel; return undefined; }
      if (key === "enter") {
        if (p.sel === 0) {
          // 默认项「用上一页配置的模型」直选零配置（不写 model 字段，运行时用当前模型——SW-24）
          this.deps.writeSearch({ backend: "auto", model: undefined });
          p.chosen = "llm"; p.model = null; p.stage = "opts";
          this.notice(t("onboard.p4.writtenAuto", { name: this.activeName() }), "ok");
        } else {
          p.stage = "provs";
          const conf = this.configuredProviders();
          p.sel = Math.max(0, conf.findIndex((x) => x.id === this.p2.active));
          p.notice = "";
        }
        return undefined;
      }
    } else if (p.stage === "provs") {
      const conf = this.configuredProviders();
      if (key === "up" || key === "down") { p.sel = Math.max(0, Math.min(conf.length - 1, p.sel + (key === "down" ? 1 : -1))); return undefined; }
      if (key === "enter") {
        const target = conf[p.sel];
        if (target === undefined) return undefined;
        p.provOpt = target.id;
        p.models = [];
        p.stage = "models"; // 先落「加载中」渲染（models 空 → 显示加载行）；异步到达后重绘
        p.sel = 0;
        this.deps.listModels(target.id).then((models) => {
          if (p.stage !== "models" || p.provOpt !== target.id) return; // 用户已离开该分支
          p.models = models;
          if (models.length === 0) p.stage = "manual"; // 空清单同拉取失败——回退手动输入行（SW-24）
          this.deps.requestRender?.();
        }).catch(() => {
          if (p.stage !== "models" || p.provOpt !== target.id) return;
          p.stage = "manual"; // 拉取失败回退手动输入模型名行（SW-24）
          this.deps.requestRender?.();
        });
        return undefined;
      }
    } else if (p.stage === "models") {
      if (p.models.length === 0) return undefined; // 清单未到——等待（定高渲染显示加载行）
      if (key === "up" || key === "down") { p.sel = Math.max(0, Math.min(p.models.length - 1, p.sel + (key === "down" ? 1 : -1))); return undefined; }
      if (key === "enter") {
        const m = p.models[p.sel];
        if (m === undefined) return undefined;
        this.pinModel(`${p.provOpt ?? ""}/${m}`);
        return undefined;
      }
    } else if (p.stage === "manual") {
      if (key === "enter") {
        const draft = (p.drafts["__manual"] ?? "").trim();
        if (draft === "") { this.notice(t("onboard.web.manualEmpty"), "warn"); return undefined; }
        this.pinModel(`${p.provOpt ?? ""}/${draft}`);
        return undefined;
      }
      if (key.length === 1 && isPrintable(key)) { p.drafts["__manual"] = (p.drafts["__manual"] ?? "") + key; return undefined; }
    } else if (p.stage === "key" && p.keyOpt !== null) {
      if (key === "up" || key === "down") {
        // 输入态下 ↑↓ 直接换后端（草稿按行保留——SW-25）；LLM 行切入模型子态
        const idx = WEB_OPTS.findIndex((x) => x.id === p.keyOpt);
        const target = WEB_OPTS[Math.max(0, Math.min(WEB_OPTS.length - 1, idx + (key === "down" ? 1 : -1)))];
        if (target === undefined) return undefined;
        if (target.id === "llm") { p.stage = "llm"; p.sel = 0; p.notice = ""; }
        else p.keyOpt = target.id;
        return undefined;
      }
      if (key === "enter") {
        const draft = (p.drafts[p.keyOpt] ?? "").trim();
        if (draft === "") { this.notice(t("onboard.key.empty"), "warn"); return undefined; }
        const envName = ENV_NAME[p.keyOpt];
        this.deps.appendSecret(envName, draft);
        this.deps.writeSearch(p.keyOpt === "tavily" ? { backend: "auto", tavilyApiKey: `$ENV:${envName}` } : { backend: "auto", braveApiKey: `$ENV:${envName}` });
        p.chosen = p.keyOpt;
        p.drafts[p.keyOpt] = "";
        this.notice(`${t("onboard.web.keyOk", { envName: envName })}`, "ok");
        return undefined;
      }
      if (key.length === 1 && isPrintable(key)) { p.drafts[p.keyOpt] = (p.drafts[p.keyOpt] ?? "") + key; return undefined; }
    }
    if (key === "ctrl+n") {
      if (p.chosen === null) { this.notice(t("onboard.web.needChoice"), "warn"); return undefined; }
      this.page = 5;   // T6d：网络搜索之后进导入页（原「完成」顺延一页）
      return undefined;
    }
    return undefined;
  }

  /* ── 第 5 页 · 从其他 agent 导入记忆（T6d——Space 勾选（第 2 页同键不同义先例）+ 整理开关 D20） ── */
  private keyPM(key: string): OnboardingOutcome | undefined {
    const p = this.pm;
    const rows = p.sources.length + 1;   // 末行 = 整理开关
    if (key === "up" || key === "down") {
      p.sel = Math.max(0, Math.min(rows - 1, p.sel + (key === "down" ? 1 : -1)));
      return undefined;
    }
    if (key === " ") {
      if (p.sel < p.sources.length) {
        const src = p.sources[p.sel]!;
        if (!src.available || src.count === 0) { this.notice(t("onboard.p5.noNotes", { label: src.label }), "warn"); return undefined; }
        if (p.checked.has(src.id)) p.checked.delete(src.id);
        else p.checked.add(src.id);
        p.notice = "";
      } else {
        p.organize = !p.organize;
        p.notice = "";
      }
      return undefined;
    }
    if (key === "ctrl+n") {
      if (p.importing) return undefined;   // 导入中不理键
      if (p.done) return { kind: "completed", ...(p.importResult !== undefined ? { importResult: p.importResult } : {}) };   // 已尝试过（成功/失败）→ 直接完成
      if (p.checked.size === 0) return { kind: "completed" };   // 无勾选 = 跳过导入直接完成
      p.importing = true;
      this.notice(t("onboard.pm.importing"), "warn");
      void Promise.resolve(this.deps.importMemory([...p.checked], p.organize)).then((r) => {
        p.importing = false;
        p.done = true;
        p.importResult = r;
        this.notice(t("onboard.p5.imported", { n: r.imported, skip: r.skipped }), "ok");
        this.deps.requestRender?.();
        this.deps.finish?.({ kind: "completed", importResult: r });   // 宿主注入的自动收尾（引导关窗 + toast）
      }).catch(() => {
        p.importing = false;
        p.done = true;
        this.notice(t("onboard.pm.importFail"), "err");
        this.deps.requestRender?.();
      });
      return undefined;
    }
    return undefined;
  }

  private configuredProviders(): OnboardingProvider[] {
    return this.deps.providers.filter((x) => this.p2.configured.includes(x.id));
  }

  private pinModel(qualified: string): void {
    const p = this.p3;
    this.deps.writeSearch({ backend: "auto", model: qualified }); // 钉选值带提供商前缀（SW-24，Reasonix web_search_model 同款格式）
    p.chosen = "llm"; p.model = qualified; p.stage = "opts"; p.drafts["__manual"] = "";
    this.notice(t("onboard.p4.writtenPin", { model: qualified }), "ok");
  }

  /* ── 渲染（定高防闪烁纪律：三页/各状态下总行数恒定） ──
   *  dock（2026-10-02 用户拍板，推翻「垂直居中 + 固定 96 宽」旧形态）：传输入框几何（bottom = 输入框
   *  顶边行号即 fullapp 的 divRow、width = 输入框宽 leftW）→ 弹窗底边贴输入框上缘、左缘对齐 col=0、
   *  宽度与输入框一致——与 view/dialog 窗 dock 形态同款几何；leftW = cols−sidebarW−1 ≤ cols−1 恒成立，
   *  CTU-05 不变量（col+width ≤ cols−1）不破。不传保持居中旧口径（测试兜底）。 */
  render(cols: number, rows: number, dock?: { bottom: number; width: number }): { lines: string[]; row: number; col: number; width: number } {
    // 760×540 原型值按字符栅格等比适配（SW-22）：96×24 基准，小终端等比收窄（dock 时宽让位于输入框宽）。
    // CTU-05（2026-09-28 修复）：下限钳制不得把「最小设计尺寸」置于「终端实际尺寸」之上——
    // 旧 max(40,…) 在 cols≤40 时 mw=40 ≥ cols、col=0 → 合成行写满底行右角格，conhost 防御①
    // （fullscreen 底行截断在 overlay 合成之前，合成层不受 cols−1 约束）失守；实测 cols≤40 且
    // rows 9–14 全档末行宽 = cols。改为两分支各自 ≤ cols−1 / ≤ rows 再取 max（popuplayout 的
    // availW = cols−1 同口径），cols≤40 时取 cols−1（弹窗占 0..cols−2 列）。任意终端尺寸恒有
    // col+width ≤ cols−1；行向 body 裁剪后 lines = 6 + max(0, mh−7) ≤ mh ≤ rows（rows < 7 的
    // 极小终端退化成 6 行纯框，被 fullscreen 的 r ≥ rows 裁剪安全吞掉——横向不变量与 conhost
    // 防御不受影响）。cols≥41 / rows≥13 与旧口径完全一致（收窄只在小终端生效）。
    const docked = dock !== undefined;
    const mw = docked
      ? Math.max(4, Math.min(dock!.width, cols - 1))
      : Math.max(Math.min(40, cols - 1), Math.min(96, cols - 8));
    const cap = Math.max(Math.min(12, rows), Math.min(24, rows - 2)); // 框高上限（rows 分支口径同旧恒值）
    const inner = Math.max(0, mw - 2);
    // 框高随内容收缩（2026-10-07 用户走查「内容的行数应该根据框体高度自动判断」——旧恒 cap 档的框
    // 装 p4 opts 六七行内容、下方大片空白）：第 2 页两态恒撑满（分页页宽与输入块钉底都以满高布局，
    // 且 bodyP2 渲染期回写 pageSize/pageIdx 不可探测重入），其余页先按满高试渲染一遍取实际内容行数
    // 定框；同状态重绘行数恒定（防闪烁的实质），页/子态切换框随内容。钳制类列表显示行数 =
    // min(清单长, 满高预算) 与框高互为收敛（短清单 → 小框 → 显示全部；长清单 → 满框 → 预算上限），
    // 试渲染与正式渲染稳定同形。
    const bodyHFull = cap - 7;
    let bodyH = bodyHFull;
    if (this.page !== 2) {
      const probe: string[] = [];
      if (this.page === 1) this.bodyP1(probe, bodyHFull, inner);
      else if (this.page === 3) this.bodyPV(probe, bodyHFull, inner);
      else if (this.page === 4) this.bodyP3(probe, bodyHFull, inner);
      else this.bodyPM(probe, bodyHFull, inner);
      bodyH = Math.max(1, Math.min(bodyHFull, probe.length));
    }
    const bc = "accent";
    const box = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, inner) + theme.fg(bc, "│"));
    const body: string[] = [];
    if (this.page === 1) this.bodyP1(body, bodyH, inner);
    else if (this.page === 2) this.bodyP2(body, bodyH, inner);
    else if (this.page === 3) this.bodyPV(body, bodyH, inner);
    else if (this.page === 4) this.bodyP3(body, bodyH, inner);
    else this.bodyPM(body, bodyH, inner);
    while (body.length < bodyH) body.push(""); // 定高垫行——条件性增删行即闪烁源（浮层纪律）
    if (body.length > bodyH) body.length = Math.max(0, bodyH); // CTU-05：P1 body 简介回流后 7~9 行（窄终端折行更多），bodyH 不足时裁尾（旧「只垫不裁」让 lines 超 mh 预算顶穿底行——rows≤12 时底框/键位行整行被裁不可见）
    const step = theme.fg("info", t("onboard.step", { page: this.page, total: PAGE_TITLES.length }));   // 分母随标题数组派生（T6d 加页防再漂）
    const title = PAGE_TITLES[this.page - 1]!;
    const lines = [
      theme.fg(bc, "╭" + "─".repeat(inner) + "╮"),
      box(` ${step}  ${theme.fg("fg", title)}`),
      box(theme.fg("border", "─".repeat(inner))),
      ...body.map((l) => box(` ${l}`)),
      box(theme.fg("border", "─".repeat(inner))),
      box(` ${this.footLine(inner - 1)}`),
      theme.fg(bc, "╰" + "─".repeat(inner) + "╯"),
    ];
    const row = docked
      ? Math.max(0, dock!.bottom - lines.length) // 底边贴输入框上缘（弹窗 ╰ 在 divRow−1，╭ 输入框顶边在 divRow）
      : Math.max(0, Math.floor((rows - lines.length) / 2)); // 居中按实际框高（收缩后不按上限偏移）
    const col = docked ? 0 : Math.max(0, Math.floor((cols - mw) / 2)); // 左缘对齐输入框（左栏 col=0）
    return { lines, row, col, width: mw };
  }

  private noticeLine(kind: NoticeKind, text: string): string {
    if (text === "") return "";
    return theme.fg(kind === "ok" ? "accent" : kind === "err" ? "err" : "warn", text); // 三色语义：成功青玉/引导暖金/真错误赭石——成功永不用红（SW-22）
  }

  private foot(items: { key: string; label: string; on: boolean; why?: string }[], inner: number): string {
    const parts = items.map((it) => {
      const seg = `${it.on ? theme.fg("accent", it.key) : theme.dim(it.key)} ${it.on ? it.label : theme.dim(it.label)}`;
      return it.on ? seg : `${seg}${it.why !== undefined && it.why !== "" ? theme.fg("warn", `（${it.why}）`) : ""}`;
    });
    const note = theme.dim(t("onboard.dockNote"));
    const line = parts.join(theme.dim(" · "));
    const gap = inner - visibleWidth(line) - visibleWidth(note) - 1;
    return gap > 2 ? `${line}${" ".repeat(gap)}${note}` : truncateToWidth(line, inner);
  }

  private footLine(inner: number): string {
    if (this.page === 1) return this.foot([{ key: "Ctrl + Q", label: t("onboard.foot.quit"), on: true }, { key: "Ctrl + N", label: t("onboard.foot.next"), on: true }], inner);
    if (this.page === 2) {
      const ready = this.p2.active !== null;
      return this.foot([
        { key: "Space", label: t("onboard.foot.setActive"), on: true },
        { key: "Ctrl + N", label: t("onboard.foot.next"), on: ready, why: ready ? "" : t("onboard.foot.whyNoProvider") },
      ], inner);
    }
    if (this.page === 3) return this.foot([{ key: "Ctrl + N", label: t("onboard.foot.next"), on: true }], inner);
    if (this.page === 4) {
      const ready = this.p3.chosen !== null;
      return this.foot([{ key: "Ctrl + N", label: t("onboard.p4.footNext"), on: ready, why: ready ? "" : t("onboard.p4.footWhy") }], inner);
    }
    return this.foot([
      { key: "Space", label: t("onboard.foot.check"), on: true },
      { key: "Ctrl + N", label: t("onboard.foot.importDone"), on: !this.pm.importing, why: this.pm.importing ? t("onboard.foot.whyImporting") : this.pm.checked.size === 0 ? t("onboard.foot.whyNoCheck") : "" },
    ], inner);
  }

  private bodyP1(out: string[], _h: number, inner: number): void {
    // 简介按内容区宽回流（2026-10-02 走查：100 格 > 内容区 93 格被截尾丢「可插拔。」——宽度变化内容必须回流）
    for (const l of wrapText(theme.dim(t("onboard.p1.intro")), Math.max(8, inner - 1))) out.push(l);
    out.push("");
    const feat = (b: string, t: string) => {
      out.push(` ${theme.fg("accent", "◆")} ${theme.fg("fg", b)}${theme.dim(t)}`);
    };
    feat(t("onboard.p1.feat1.head"), t("onboard.p1.feat1.body"));
    feat(t("onboard.p1.feat2.head"), t("onboard.p1.feat2.body"));
    feat(t("onboard.p1.feat3.head"), t("onboard.p1.feat3.body"));
    out.push("");
    out.push(theme.dim(t("onboard.p1.nameOrigin")));
    void inner;
  }

  private prow(selected: boolean, done: boolean, cells: string, active?: boolean): string {
    const sel = selected ? theme.bg("accentSoft", theme.fg("accent", "▌") + cells) : ` ${cells}`;
    const marks = `${done ? theme.fg("accent", "✓") : " "}${active === true ? ` ${theme.fg("accent", t("onboard.p2.activeMark"))}` : ""}`;
    return `${sel}${marks}`;
  }

  private bodyP2(out: string[], bodyH: number, inner: number): void {
    const p = this.p2;
    const providers = this.deps.providers;
    const keyMode = p.mode === "key";
    // 列表页大小动态算（2026-10-02 用户拍板「自动判断显示多少，到『第 x / y 页』行之上为止」）：
    // 正文可用行数 − 提示行 1 − notice 行 1；列表撑满、提示行钉正文末行（贴下方灰色分隔线）。
    // 键位翻页与渲染同源（resize 后页宽跟随）；页号恒随选中项收敛（页宽变化自愈）。
    p.pageSize = Math.max(1, bodyH - 2);
    const pages = Math.max(1, Math.ceil(providers.length / p.pageSize));
    p.pageIdx = Math.max(0, Math.min(pages - 1, Math.floor(p.sel / p.pageSize)));
    if (keyMode) {
      // Key 输入态：列表撑满剩余正文（窗口跟随选中项），底部块恒钉底——快捷键提示/空行/粘贴提示/
      // 静默盲输行/notice 占位共 5 行（列表态「垫行 + 两行钉底」同款纪律，弹窗定高不顶撑 SW-22）。
      // 2026-10-07 用户走查：旧「收窄为 4 行」把大半正文垫成空白、输入区悬在中腰——列表能显多少显多少。
      const reserved = 5;
      const vis = Math.max(1, bodyH - reserved);
      const start = Math.max(0, Math.min(p.sel - 1, providers.length - vis));
      for (let gi = start; gi < Math.min(start + vis, providers.length); gi++) {
        out.push(this.providerRow(gi, inner));
      }
      while (out.length < bodyH - reserved) out.push(""); // 列表不足垫空——底部块恒贴脚下分隔线
      out.push(theme.dim(t("onboard.p2.keyHint")));
      const prov = providers[p.sel];
      if (prov !== undefined) {
        const draft = p.drafts[prov.id] ?? "";
        const conf = p.configured.includes(prov.id);
        out.push("");
        out.push(theme.dim(t("onboard.p2.pasteHint", { name: prov.name, conf: conf ? t("onboard.p2.pasteConf") : undefined })));
        out.push(`${theme.fg("accent", "▍")} ${draft === "" ? theme.dim(t("onboard.blindPlaceholder")) : theme.fg("fg", `${t("onboard.p2.typed", { n: draft.length })}`)}`); // SW-23 静默盲输
      }
      out.push(this.noticeLine(p.noticeKind, p.notice));
      return;
    }
    const start = p.pageIdx * p.pageSize;
    for (let gi = start; gi < Math.min(start + p.pageSize, providers.length); gi++) {
      out.push(this.providerRow(gi, inner));
    }
    while (out.length < bodyH - 2) out.push(""); // 定高垫行——提示行与 notice 恒钉正文底部两行
    out.push(this.noticeLine(p.noticeKind, p.notice));
    out.push(theme.dim(t("onboard.pm.pageFoot", { n: p.pageIdx + 1, m: pages })));
  }

  /** 提供商行（列表态/输入态共用渲染）。 */
  private providerRow(gi: number, inner: number): string {
    const p = this.p2;
    const prov = this.deps.providers[gi]!;
    const conf = p.configured.includes(prov.id);
    const cells = `${prov.name}${theme.dim(` · ${prov.envKey ?? "API Key"}`)}`;
    return truncateToWidth(this.prow(gi === p.sel, conf, cells, p.active === prov.id), inner);
  }

  private bodyPV(out: string[], bodyH: number, inner: number): void {
    const p = this.pv;
    if (p.mode === "opts") {
      out.push(theme.fg("muted", t("onboard.p3.intro")));
      out.push("");
      for (const [i, o] of VISION_OPTS.entries()) {
        const mark = i === p.sel ? theme.fg("accent", "●") : theme.dim("○");
        out.push(`${mark} ${theme.fg("fg", o.name)}${theme.dim("——" + o.desc)}`);
      }
    } else {
      out.push(theme.fg("muted", t("onboard.p3.listIntro")));
      out.push("");
      const rows = p.loading ? [t("onboard.loading")] : p.models.length > 0 ? p.models : [t("onboard.p3.emptyList")];
      const shown = rows.slice(0, VISION_LIST_ROWS);
      for (const [i, m] of shown.entries()) {
        const mark = i === p.sel ? theme.fg("accent", "●") : theme.dim("○");
        out.push(`${mark} ${theme.fg("fg", truncateToWidth(m, inner - 4))}`);
      }
      for (let i = shown.length; i < VISION_LIST_ROWS; i++) out.push(""); // 恒定 5 行空槽留白（防闪烁铁律）
      if (rows.length > VISION_LIST_ROWS) out.push(theme.dim(t("onboard.vision.more", { n: rows.length - VISION_LIST_ROWS })));
    }
    // notice 恒占位两行（空则空行）——框高随内容收缩后，notice 出现/消失不得再引起框高跳动
    out.push("");
    out.push(this.noticeLine(p.noticeKind, p.notice));
  }

  private bodyP3(out: string[], bodyH: number, inner: number): void {
    const p = this.p3;
    out.push(theme.dim(t("onboard.p4.intro")));
    out.push(""); // 说明行与下方内容（选项/子态铅行）间空行（2026-10-07 用户走查）——各子态统一
    const optRow = (o: (typeof WEB_OPTS)[number], i: number) => {
      const desc = o.id === "llm" && p.model !== null ? t("onboard.p4.pinned", { model: p.model }) : o.desc;
      return truncateToWidth(this.prow(i === p.sel, false, `${o.name}${theme.dim(` · ${desc}`)}`), inner);
    };
    const stageLead = (t: string) => out.push(theme.fg("info", t));
    // 长清单按框高钳制 + 窗口跟随选中项 + 快捷键行钉底（2026-10-07 与 key 输入态同款纪律——
    // 旧全量 forEach 超高被 render 兜底裁尾，快捷键行/notice 整行丢失不可见）。
    // 预算五行 = 函数头说明行 + 空行 + stageLead 铅行 + 快捷键 + notice——漏算公共头行会把
    // 钉底行顶进裁尾区（首版 −3 即犯此错：19 行内容被裁掉快捷键行）。
    const clipList = (items: string[], render: (gi: number) => string, hint: string): void => {
      const vis = Math.max(1, bodyH - 5);
      const start = Math.max(0, Math.min(p.sel - 1, items.length - vis));
      for (let gi = start; gi < Math.min(start + vis, items.length); gi++) out.push(render(gi));
      out.push(theme.dim(hint));
    };
    if (p.stage === "opts") {
      WEB_OPTS.forEach((o, i) => out.push(optRow(o, i)));
      out.push(theme.dim(t("onboard.keys.moveSelect")));
    } else if (p.stage === "llm") {
      stageLead(t("onboard.web.llmStage"));
      out.push(truncateToWidth(this.prow(p.sel === 0, false, `${t("onboard.p4.optPrevRow", { name: this.activeName() })}${theme.dim(t("onboard.p4.optPrevDesc"))}`), inner));
      out.push(truncateToWidth(this.prow(p.sel === 1, false, `${t("onboard.p4.optOtherRow")}${theme.dim(t("onboard.p4.optOtherDesc"))}`), inner));
      out.push(theme.dim(t("onboard.keys.moveSelectBack")));
    } else if (p.stage === "provs") {
      stageLead(t("onboard.web.provStage"));
      const conf = this.configuredProviders();
      clipList(conf.map((x) => x.name), (gi) => truncateToWidth(this.prow(gi === p.sel, false, conf[gi]!.name, this.p2.active === conf[gi]!.id), inner), t("onboard.keys.movePickProv"));
    } else if (p.stage === "models") {
      stageLead(t("onboard.p4.llmFrom", { name: this.provById(p.provOpt ?? "").name }));
      if (p.models.length === 0) out.push(theme.dim(t("onboard.web.modelsLoading")));
      else clipList(p.models, (gi) => truncateToWidth(this.prow(gi === p.sel, false, p.models[gi]!), inner), t("onboard.keys.movePin"));
    } else if (p.stage === "manual") {
      stageLead(t("onboard.p4.manualLead", { name: this.provById(p.provOpt ?? "").name }));
      const draft = p.drafts["__manual"] ?? "";
      out.push(`${theme.fg("accent", "▍")} ${draft === "" ? theme.dim(t("onboard.web.manualPlaceholder")) : theme.fg("fg", draft)}`);
      out.push(theme.dim(t("onboard.keys.pinBack")));
    } else if (p.stage === "key" && p.keyOpt !== null) {
      WEB_OPTS.forEach((o, i) => out.push(optRow(o, i)));
      const o = WEB_OPTS.find((x) => x.id === p.keyOpt)!;
      const draft = p.drafts[p.keyOpt] ?? "";
      out.push("");
      out.push(theme.dim(t("onboard.p4.openSite", { site: o.id === "tavily" ? "tavily.com" : "brave.com/search/api" })));
      out.push(`${theme.fg("accent", "▍")} ${draft === "" ? theme.dim(t("onboard.blindPlaceholder")) : theme.fg("fg", `${t("onboard.p2.typed", { n: draft.length })}`)}`); // SW-23
      out.push(theme.dim(t("onboard.keys.switchBackend")));
    }
    out.push(this.noticeLine(p.noticeKind, p.notice));
    void bodyH;
  }

  /* ── 第 5 页 · 导入记忆正文（v3 简图③：五源行 + 整理开关 + 说明；行数恒定防闪烁） ── */
  private bodyPM(out: string[], _bodyH: number, inner: number): void {
    const p = this.pm;
    out.push(theme.fg("muted", t("onboard.pm.intro")));
    out.push("");
    for (const [i, src] of p.sources.entries()) {
      const mark = p.checked.has(src.id) ? theme.fg("accent", "●") : theme.dim("○");
      const count = !src.available ? theme.dim(t("onboard.p5.notInstalled"))
        : src.count === 0 ? theme.dim(t("onboard.pm.zeroNotes"))
        : theme.fg("fg", t("onboard.p5.notesCount", { n: src.count }));
      const row = `${mark} ${theme.fg("fg", src.label)}${theme.dim(` · ${count}${src.available && src.count > 0 ? ` · ${src.note}` : ""}`)}`;
      out.push(truncateToWidth(i === p.sel ? theme.bg("accentSoft", theme.fg("accent", "▌") + row) : ` ${row}`, inner));
    }
    out.push("");
    const optMark = p.organize ? theme.fg("accent", "[✓]") : theme.dim("[ ]");
    const optRow = `${optMark} ${theme.fg("fg", t("onboard.pm.organizeRow"))}${theme.dim(t("onboard.pm.organizeDefaultOff"))}`;
    out.push(truncateToWidth(p.sources.length === p.sel ? theme.bg("accentSoft", theme.fg("accent", "▌") + optRow) : ` ${optRow}`, inner));
    out.push(theme.dim(t("onboard.pm.organizeDesc1")));
    out.push(theme.dim(t("onboard.pm.organizeDesc2")));
    // notice 恒占位两行（空则空行）——同 bodyPV：框高收缩后 notice 不得引起框高跳动
    out.push("");
    out.push(this.noticeLine(p.noticeKind, p.notice));
  }
}
