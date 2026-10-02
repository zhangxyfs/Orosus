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
  /** 异步清单到达后的重绘请求（FullApp 挂接时强制注入自家调度——宿主直驱测试可省略）。 */
  requestRender?(): void;
}

export type OnboardingOutcome = { kind: "completed" } | { kind: "quit" };

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
const VISION_OPTS = [
  { id: "off", name: "暂不启用（默认）", desc: "不生成视觉摘要——降级图只留路径标签" },
  { id: "auto", name: "自动", desc: "当前模型支持图片时直接用它看图" },
  { id: "pick", name: "指定视觉模型", desc: "从已配置提供商的多模态模型中选择" },
] as const;
const VISION_LIST_ROWS = 5; // 恒定行数（原型走查③：不足补空槽——高度恒定防闪烁铁律）

const PAGE_SIZE = 8;
const WEB_OPTS = [
  { id: "llm", name: "LLM Web Search", desc: "默认 · 用已配置的模型联网搜索，无需任何 Key" },
  { id: "tavily", name: "Tavily", desc: "专业搜索服务 · 需 API Key · tavily.com" },
  { id: "brave", name: "Brave", desc: "独立索引搜索 · 需 API Key · brave.com/search/api" },
] as const;
const ENV_NAME: Record<"tavily" | "brave", string> = { tavily: "TAVILY_API_KEY", brave: "BRAVE_API_KEY" };

export class OnboardingSession {
  private deps: OnboardingDeps;
  private page: 1 | 2 | 3 | 4 = 1;
  private p2: P2State;
  private p3: P3State;
  private pv: PVState;

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
  }

  /** 测试探针。 */
  get stateRef(): { page: number; p2: P2State; p3: P3State; pv: PVState } {
    return { page: this.page, p2: this.p2, p3: this.p3, pv: this.pv };
  }

  private provById(id: string): OnboardingProvider {
    return this.deps.providers.find((p) => p.id === id) ?? { id, name: id, baseUrl: "", type: "openai" };
  }
  private activeName(): string {
    return this.p2.active === null ? "（未配置）" : this.provById(this.p2.active).name;
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
      this.notice("Ctrl + Q 仅在第 1 页可用——完成引导后即可正常使用 /quit 退出", "warn");
      return undefined;
    }
    if (key === "escape") return undefined; // Esc 在引导中不占用（SW-22——留白，不绑任何语义）
    if (this.page === 1) {
      if (key === "ctrl+n") this.page = 2;
      return undefined;
    }
    if (this.page === 2) return this.keyP2(key);
    if (this.page === 3) return this.keyPV(key);
    return this.keyP3(key);
  }

  private notice(text: string, kind: NoticeKind): void {
    if (this.page === 2) { this.p2.notice = text; this.p2.noticeKind = kind; }
    else if (this.page === 3) { this.pv.notice = text; this.pv.noticeKind = kind; }
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
        this.notice(`已写入 config.toml [provider]（provider = ${prov.id}）`, "ok");
      } else {
        this.notice(`先输入 ${prov.name} 的 Key，再设为当前使用`, "warn");
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
      if (draft === "") { this.notice("Key 不能为空——粘贴后回车确认", "warn"); return undefined; }
      const envKey = prov.envKey ?? `${prov.id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      this.deps.appendSecret(envKey, draft);
      if (!p.configured.includes(prov.id)) p.configured.push(prov.id);
      this.deps.writeProvider({ id: prov.id, type: prov.type, baseUrl: prov.baseUrl, apiKey: `$ENV:${envKey}` });
      p.drafts[prov.id] = "";
      if (p.active === null) {
        p.active = prov.id;
        this.deps.setModel(prov.id);
        this.notice(`Key 已写入 secrets.env（${envKey}），并设为当前使用——已写入 config.toml [provider]`, "ok");
      } else {
        this.notice(`Key 已写入 secrets.env（${envKey}）——${prov.name} 备用（Space 设为当前使用）`, "ok");
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
      if (p.active === null) { this.notice("先配置一个提供商——首个配好的自动设为当前使用", "warn"); return undefined; }
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
          this.notice("已写入 modules.d/tool-media.toml（视觉摘要停用）", "ok");
        } else if (o.id === "auto") {
          this.deps.writeVision("auto");
          this.notice("已设为自动——当前模型支持图片时直接用它看图", "ok");
        } else {
          p.mode = "list"; p.sel = 0; p.loading = true; p.models = []; p.notice = "";
          this.deps.visionModels().then((models) => {
            if (p.mode !== "list") return; // 用户已返回选项页
            p.models = models; p.loading = false;
            if (models.length === 0) this.notice("已配置的提供商里没有目录可证的多模态模型——可回上一页换提供商，或直接下一步", "warn");
            this.deps.requestRender?.();
          }).catch(() => {
            if (p.mode !== "list") return;
            p.loading = false;
            this.notice("多模态模型清单读取失败——可直接下一步稍后在 /settings 配置", "warn");
            this.deps.requestRender?.();
          });
        }
        return undefined;
      }
      const m = p.models[p.sel];
      if (m !== undefined) {
        this.deps.writeVision(m);
        this.notice(`已指定视觉模型 ${m}`, "ok");
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
          this.notice(`已写入 config.toml [tool-web] search（用上一页配置的模型 · ${this.activeName()}，失败自动降级 Tavily / Brave）`, "ok");
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
        if (draft === "") { this.notice("模型名不能为空——输入后回车钉住", "warn"); return undefined; }
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
        if (draft === "") { this.notice("Key 不能为空——粘贴后回车确认", "warn"); return undefined; }
        const envName = ENV_NAME[p.keyOpt];
        this.deps.appendSecret(envName, draft);
        this.deps.writeSearch(p.keyOpt === "tavily" ? { backend: "auto", tavilyApiKey: `$ENV:${envName}` } : { backend: "auto", braveApiKey: `$ENV:${envName}` });
        p.chosen = p.keyOpt;
        p.drafts[p.keyOpt] = "";
        this.notice(`Key 已写入 secrets.env（${envName}）——降级链上自动取用`, "ok");
        return undefined;
      }
      if (key.length === 1 && isPrintable(key)) { p.drafts[p.keyOpt] = (p.drafts[p.keyOpt] ?? "") + key; return undefined; }
    }
    if (key === "ctrl+n") {
      if (p.chosen === null) { this.notice("请先选择一个搜索后端——LLM 默认零配置，回车即选", "warn"); return undefined; }
      return { kind: "completed" };
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
    this.notice(`已写入 config.toml [tool-web] search（钉住 ${qualified}，失败自动降级 Tavily / Brave）`, "ok");
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
    const mh = Math.max(Math.min(12, rows), Math.min(24, rows - 2));
    const inner = Math.max(0, mw - 2);
    const bodyH = mh - 7; // 框 2 + 头 2 + 头下分隔 1 + 脚下分隔 1 + 脚 1
    const bc = "accent";
    const box = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, inner) + theme.fg(bc, "│"));
    const body: string[] = [];
    if (this.page === 1) this.bodyP1(body, bodyH, inner);
    else if (this.page === 2) this.bodyP2(body, bodyH, inner);
    else if (this.page === 3) this.bodyPV(body, bodyH, inner);
    else this.bodyP3(body, bodyH, inner);
    while (body.length < bodyH) body.push(""); // 定高垫行——条件性增删行即闪烁源（浮层纪律）
    if (body.length > bodyH) body.length = Math.max(0, bodyH); // CTU-05：P1 body 简介回流后 7~9 行（窄终端折行更多），bodyH 不足时裁尾（旧「只垫不裁」让 lines 超 mh 预算顶穿底行——rows≤12 时底框/键位行整行被裁不可见）
    const step = theme.fg("info", `引导 ${this.page} / 4`);
    const title = ["欢迎使用 Orosus（连山）", "选择模型提供商", "配置视觉模型", "配置网络搜索"][this.page - 1]!;
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
      : Math.max(0, Math.floor((rows - mh) / 2));
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
    const note = theme.dim("焦点锁定在引导弹窗 · Esc 未占用");
    const line = parts.join(theme.dim(" · "));
    const gap = inner - visibleWidth(line) - visibleWidth(note) - 1;
    return gap > 2 ? `${line}${" ".repeat(gap)}${note}` : truncateToWidth(line, inner);
  }

  private footLine(inner: number): string {
    if (this.page === 1) return this.foot([{ key: "Ctrl + Q", label: "退出", on: true }, { key: "Ctrl + N", label: "下一步", on: true }], inner);
    if (this.page === 2) {
      const ready = this.p2.active !== null;
      return this.foot([
        { key: "Space", label: "设为当前使用", on: true },
        { key: "Ctrl + N", label: "下一步", on: ready, why: ready ? "" : "先配好一家提供商" },
      ], inner);
    }
    const ready = this.p3.chosen !== null;
    return this.foot([{ key: "Ctrl + N", label: "完成引导", on: ready, why: ready ? "" : "先选定后端——LLM 回车即选" }], inner);
  }

  private bodyP1(out: string[], _h: number, inner: number): void {
    // 简介按内容区宽回流（2026-10-02 走查：100 格 > 内容区 93 格被截尾丢「可插拔。」——宽度变化内容必须回流）
    for (const l of wrapText(theme.dim("山夜为底、青绿为峰——一个跑在你终端里的本地 Agent：读写文件、执行命令、管理任务，模型与能力都可插拔。"), Math.max(8, inner - 1))) out.push(l);
    out.push("");
    const feat = (b: string, t: string) => {
      out.push(` ${theme.fg("accent", "◆")} ${theme.fg("fg", b)}${theme.dim(t)}`);
    };
    feat("联网能力", "——搜索与打开网页，默认用你配置的模型联网，也可以接 Tavily / Brave。");
    feat("任何提供商", "——Anthropic、OpenAI、DeepSeek、智谱、Kimi……下一步就能配好。");
    feat("目标驱动", "——给模型一个目标，它没做完不会自己停。");
    out.push("");
    out.push(theme.dim("名字由来：模块互连如山之连绵，故中文定名「连山」；oros 词根取希腊语「山」。"));
    void inner;
  }

  private prow(selected: boolean, done: boolean, cells: string, active?: boolean): string {
    const sel = selected ? theme.bg("accentSoft", theme.fg("accent", "▌") + cells) : ` ${cells}`;
    const marks = `${done ? theme.fg("accent", "✓") : " "}${active === true ? ` ${theme.fg("accent", "[使用中]")}` : ""}`;
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
      // Key 输入态下列表收窄为 4 行（窗口跟随选中项）——弹窗定高不顶撑（SW-22）
      const vis = 4;
      const start = Math.max(0, Math.min(p.sel - 1, providers.length - vis));
      for (let gi = start; gi < Math.min(start + vis, providers.length); gi++) {
        out.push(this.providerRow(gi, inner));
      }
      out.push(theme.dim("↑ ↓ 换提供商 · Enter 确认 · Backspace 删除 / 退出输入"));
      const prov = providers[p.sel];
      if (prov !== undefined) {
        const draft = p.drafts[prov.id] ?? "";
        const conf = p.configured.includes(prov.id);
        out.push("");
        out.push(theme.dim(`粘贴 ${prov.name} 的 API Key（官网获取，输入不显示${conf ? "；已配置过，回车覆盖" : ""}）`));
        out.push(`${theme.fg("accent", "▍")} ${draft === "" ? theme.dim("（静默盲输——粘贴后回车）") : theme.fg("fg", `已输入 ${draft.length} 字符`)}`); // SW-23 静默盲输
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
    out.push(theme.dim(`第 ${p.pageIdx + 1} / ${pages} 页 · ↑ ↓ 移动 · Enter 输 Key · Space 设当前使用 · PgUp / PgDn 翻页`));
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
      out.push(theme.fg("muted", "给不支持图片的模型配一双眼睛（视觉摘要 / 看图能力）——可跳过"));
      out.push("");
      for (const [i, o] of VISION_OPTS.entries()) {
        const mark = i === p.sel ? theme.fg("accent", "●") : theme.dim("○");
        out.push(`${mark} ${theme.fg("fg", o.name)}${theme.dim("——" + o.desc)}`);
      }
    } else {
      out.push(theme.fg("muted", "多模态模型（已按提供商过滤）· Enter 指定 / Backspace 返回"));
      out.push("");
      const rows = p.loading ? ["加载中…"] : p.models.length > 0 ? p.models : ["（无多模态模型）"];
      const shown = rows.slice(0, VISION_LIST_ROWS);
      for (const [i, m] of shown.entries()) {
        const mark = i === p.sel ? theme.fg("accent", "●") : theme.dim("○");
        out.push(`${mark} ${theme.fg("fg", truncateToWidth(m, inner - 4))}`);
      }
      for (let i = shown.length; i < VISION_LIST_ROWS; i++) out.push(""); // 恒定 5 行空槽留白（防闪烁铁律）
      if (rows.length > VISION_LIST_ROWS) out.push(theme.dim(`  ↑ 还有 ${rows.length - VISION_LIST_ROWS} 个未显示`));
    }
    const n = this.noticeLine(p.noticeKind, p.notice);
    if (n !== "") { out.push(""); out.push(n); }
  }

  private bodyP3(out: string[], bodyH: number, inner: number): void {
    const p = this.p3;
    out.push(theme.dim("搜索后端按「LLM → Tavily → Brave」自动降级；此处选择会写入配置，之后随时可在 /settings 里改。"));
    const optRow = (o: (typeof WEB_OPTS)[number], i: number) => {
      const desc = o.id === "llm" && p.model !== null ? `已钉住模型：${p.model}` : o.desc;
      return truncateToWidth(this.prow(i === p.sel, p.chosen === o.id, `${o.name}${theme.dim(` · ${desc}`)}`), inner);
    };
    const stageLead = (t: string) => out.push(theme.fg("info", t));
    if (p.stage === "opts") {
      WEB_OPTS.forEach((o, i) => out.push(optRow(o, i)));
      out.push(theme.dim("↑ ↓ 移动 · Enter 选择"));
    } else if (p.stage === "llm") {
      stageLead("LLM Web Search · 选择搜索用的模型");
      out.push(truncateToWidth(this.prow(p.sel === 0, false, `使用上一页配置的模型（${this.activeName()} · 默认）${theme.dim(" · 与主对话同一模型，零额外配置")}`), inner));
      out.push(truncateToWidth(this.prow(p.sel === 1, false, `另选一个模型…${theme.dim(" · 可跨第 2 页已配置的提供商选择")}`), inner));
      out.push(theme.dim("↑ ↓ 移动 · Enter 选择 · Backspace 返回"));
    } else if (p.stage === "provs") {
      stageLead("LLM Web Search · 选择提供商（限第 2 页已配置的）");
      const conf = this.configuredProviders();
      conf.forEach((pr, i) => out.push(truncateToWidth(this.prow(i === p.sel, false, pr.name, this.p2.active === pr.id), inner)));
      out.push(theme.dim("↑ ↓ 移动 · Enter 选提供商 · Backspace 返回"));
    } else if (p.stage === "models") {
      stageLead(`LLM Web Search · 从 ${this.provById(p.provOpt ?? "").name} 的模型中选择`);
      if (p.models.length === 0) out.push(theme.dim("（正在加载模型清单…）"));
      else p.models.forEach((m, i) => out.push(truncateToWidth(this.prow(i === p.sel, false, m), inner)));
      out.push(theme.dim("↑ ↓ 移动 · Enter 钉住 · Backspace 返回"));
    } else if (p.stage === "manual") {
      stageLead(`LLM Web Search · ${this.provById(p.provOpt ?? "").name} 的模型清单拉取失败——手动输入模型名`);
      const draft = p.drafts["__manual"] ?? "";
      out.push(`${theme.fg("accent", "▍")} ${draft === "" ? theme.dim("（输入模型名，回车钉住）") : theme.fg("fg", draft)}`);
      out.push(theme.dim("Enter 钉住 · Backspace 删除 / 返回"));
    } else if (p.stage === "key" && p.keyOpt !== null) {
      WEB_OPTS.forEach((o, i) => out.push(optRow(o, i)));
      const o = WEB_OPTS.find((x) => x.id === p.keyOpt)!;
      const draft = p.drafts[p.keyOpt] ?? "";
      out.push("");
      out.push(theme.dim(`打开 ${o.id === "tavily" ? "tavily.com" : "brave.com/search/api"} 免费注册并创建 Key，粘贴到这里（输入不显示）`));
      out.push(`${theme.fg("accent", "▍")} ${draft === "" ? theme.dim("（静默盲输——粘贴后回车）") : theme.fg("fg", `已输入 ${draft.length} 字符`)}`); // SW-23
      out.push(theme.dim("↑ ↓ 换后端 · Enter 确认 · Backspace 删除 / 返回"));
    }
    out.push(this.noticeLine(p.noticeKind, p.notice));
    void bodyH;
  }
}
