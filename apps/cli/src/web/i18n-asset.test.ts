/** web-i18n M3 伴生测试：assets/i18n.js 纯函数核（@orosus/i18n runtime 的 JS 移植——语义逐条对齐 runtime.test.ts）。 */
import { describe, it, expect } from "vitest";
import "./assets/i18n.js";

interface I18NFace {
  t(key: string, params?: Record<string, unknown>, fallback?: string): string;
  setMessages(tag: string, table: Record<string, string>): void;
  cur(): string;
  formatTemplate(tpl: string, params?: Record<string, unknown>, tag?: string): string;
  normalizeLocaleTag(raw: string): string;
  chainFor(tag: string): string[];
}
const I = (): I18NFace => (globalThis as { OrosusI18N?: I18NFace }).OrosusI18N!;

describe("web i18n M3：runtime 移植语义", () => {
  it("① 插值/缺参空串/管道缺省/条件段", () => {
    const w = I();
    expect(w.formatTemplate("你好 {name}", { name: "山" })).toBe("你好 山");
    expect(w.formatTemplate("你好 {name}", {})).toBe("你好 ");
    expect(w.formatTemplate("模型 {model|未设}", {})).toBe("模型 未设");
    expect(w.formatTemplate("{flag?有标记}尾", { flag: true })).toBe("有标记尾");
    expect(w.formatTemplate("{flag?有标记}尾", {})).toBe("尾");
  });
  it("② 可选组与在场二选一", () => {
    const w = I();
    expect(w.formatTemplate("{（含 {m} 个）}", { m: 3 })).toBe("（含 3 个）");
    expect(w.formatTemplate("{（含 {m} 个）}", {})).toBe("");
    expect(w.formatTemplate("{不限/{raw} 轮}", { raw: 5 })).toBe("5 轮");
    expect(w.formatTemplate("{不限/{raw} 轮}", {})).toBe("不限");
  });
  it("③ 复数：ru 三形 / en 两形", () => {
    const w = I();
    expect(w.formatTemplate("{one:файл|few:файла|many:файлов}", { n: 1 }, "ru-RU")).toBe("файл");
    expect(w.formatTemplate("{one:файл|few:файла|many:файлов}", { n: 3 }, "ru-RU")).toBe("файла");
    expect(w.formatTemplate("{one:файл|few:файла|many:файлов}", { n: 5 }, "ru-RU")).toBe("файлов");
    // en 两形：brief 原断言 {one:file|other:files} 期望 "files" 与 runtime.ts 实际相抵（③a 管道缺省先于 ③b 复数，
    // PARAM_RE 含冒号 → "one:file" 命中形参名 → 实渲染 "other:files"——node 直跑 runtime.ts 验证）。
    // runtime.ts 是语义权威：改用 runtime.test.ts:46 的既成 en 复数形态（嵌套 {n} + 斜线分组——两分支皆按原语义过）。
    expect(w.formatTemplate("{one:{n} tool / other:{n} tools}", { n: 1 }, "en-US")).toBe("1 tool");
    expect(w.formatTemplate("{one:{n} tool / other:{n} tools}", { n: 2 }, "en-US")).toBe("2 tools");
  });
  it("④ 全角管道归一 + 未闭合按字面", () => {
    const w = I();
    expect(w.formatTemplate("模型 {model｜未设}", {})).toBe("模型 未设");
    expect(w.formatTemplate("a { b", {})).toBe("a { b");
  });
  it("⑤ t：命中/缺键回落 fallback/键本身；setMessages 换表即切 + cur", () => {
    const w = I();
    w.setMessages("zh-CN", { "web.shell.settings": "设置" });
    expect(w.cur()).toBe("zh-CN");
    expect(w.t("web.shell.settings")).toBe("设置");
    expect(w.t("web.none.x", undefined, "兜底")).toBe("兜底");
    expect(w.t("web.none.x")).toBe("web.none.x");
    w.setMessages("en-US", { "web.shell.settings": "Settings" });
    expect(w.t("web.shell.settings")).toBe("Settings");
    expect(w.cur()).toBe("en-US");
  });
  it("⑥ normalizeLocaleTag 分族 + chainFor 特例", () => {
    const w = I();
    expect(w.normalizeLocaleTag("zh_TW.big5")).toBe("zh-TW");
    expect(w.normalizeLocaleTag("zh-Hans-SG")).toBe("zh-CN");
    expect(w.normalizeLocaleTag("ja")).toBe("ja-JP");
    expect(w.normalizeLocaleTag("en-gb")).toBe("en-US");
    expect(w.chainFor("zh-TW")).toEqual(["zh-TW", "zh-CN", "en-US"]);
    expect(w.chainFor("en-US")).toEqual(["en-US"]);
  });
});
