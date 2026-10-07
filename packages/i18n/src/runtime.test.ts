import { describe, expect, it } from "vitest";

import { chainFor, createFloorT, createT, formatTemplate, normalizeLocaleTag, pluralCategory } from "./index.ts";
import { floorCatalogs, floorEnUS, floorKeys, floorZhCN, floorZhTW } from "./floor.ts";

describe("m5-i18n 运行时：插值与模板形态", () => {
	it("① 裸形参与缺参空串；{hh:mm:ss} 冒号名与 {reason 首行} 带尾名按首 token 取参", () => {
		expect(formatTemplate("已复制 {n} 字", { n: 12 }, "zh-CN")).toBe("已复制 12 字");
		expect(formatTemplate("{n} 次 · {hh:mm:ss}", { n: 3, "hh:mm:ss": "01:02:03" }, "zh-CN")).toBe("3 次 · 01:02:03");
		expect(formatTemplate("（{reason 首行}）", { reason: "配置校验失败" }, "zh-CN")).toBe("（配置校验失败）");
		expect(formatTemplate("A{n}B", undefined, "zh-CN")).toBe("AB");
	});

	it("② 形参带缺省 {name|默认}（含全角 ｜ 书写归一）", () => {
		expect(formatTemplate("模型: {model|（未配置）}", {}, "zh-CN")).toBe("模型: （未配置）");
		expect(formatTemplate("模型: {model|（未配置）}", { model: "glm-5.3" }, "zh-CN")).toBe("模型: glm-5.3");
		expect(formatTemplate("{model｜未设}", {}, "zh-CN")).toBe("未设");
		expect(formatTemplate("{list|无} / {list|无}", { list: "a、b" }, "zh-CN")).toBe("a、b / a、b");
	});

	it("③ 显式条件段 {flag?…} 与可选组 {（… {m} …）}", () => {
		expect(formatTemplate("{fullRes?（全分辨率原图已随附）}", { fullRes: true }, "zh-CN")).toBe("（全分辨率原图已随附）");
		expect(formatTemplate("{fullRes?（全分辨率原图已随附）}", {}, "zh-CN")).toBe("");
		expect(formatTemplate("有 {n} 个在跑{（含 {m} 个挂起审批）}", { n: 2, m: 1 }, "zh-CN")).toBe("有 2 个在跑（含 1 个挂起审批）");
		expect(formatTemplate("有 {n} 个在跑{（含 {m} 个挂起审批）}", { n: 2 }, "zh-CN")).toBe("有 2 个在跑");
		expect(formatTemplate("窗口: {n} tokens{（{pct}%）}", { n: 100, pct: 42 }, "zh-CN")).toBe("窗口: 100 tokens（42%）");
	});

	it("④ 在场二选一 {A/{raw} B}：带参段在场优先、缺席退无参段；管道分组内的路径斜线不受影响", () => {
		expect(formatTemplate("上限：{不限（仅时长兜底）/{raw} 轮}", { raw: 100 }, "zh-CN")).toBe("上限：100 轮");
		expect(formatTemplate("上限：{不限（仅时长兜底）/{raw} 轮}", {}, "zh-CN")).toBe("上限：不限（仅时长兜底）");
		const compaction = "细节{会话 {sid}（~/.orosus/sessions/ 目录）|（历史在 ~/.orosus/sessions/ 目录）}";
		expect(formatTemplate(compaction, { sid: "abc" }, "zh-CN")).toBe("细节会话 abc（~/.orosus/sessions/ 目录）");
		expect(formatTemplate(compaction, {}, "zh-CN")).toBe("细节（历史在 ~/.orosus/sessions/ 目录）");
	});

	it("⑤ 复数三形（ru 管道）与两形（en 斜线）；zh/ja/ko 单形", () => {
		const ru = "{1:{n} файл|2:{n} файла|5:{n} файлов}";
		expect(formatTemplate(ru, { n: 1 }, "ru-RU")).toBe("1 файл");
		expect(formatTemplate(ru, { n: 2 }, "ru-RU")).toBe("2 файла");
		expect(formatTemplate(ru, { n: 5 }, "ru-RU")).toBe("5 файлов");
		expect(formatTemplate(ru, { n: 11 }, "ru-RU")).toBe("11 файлов");
		expect(formatTemplate(ru, { n: 21 }, "ru-RU")).toBe("21 файл");
		expect(formatTemplate(ru, { n: 22 }, "ru-RU")).toBe("22 файла");
		expect(formatTemplate(ru, { n: 12 }, "ru-RU")).toBe("12 файлов");
		const en = "{one:{n} tool / other:{n} tools}";
		expect(formatTemplate(en, { n: 1 }, "en-US")).toBe("1 tool");
		expect(formatTemplate(en, { n: 3 }, "en-US")).toBe("3 tools");
		expect(formatTemplate("{n} 个工具", { n: 3 }, "zh-CN")).toBe("3 个工具");
	});

	it("⑥ 复数嵌套计数与混合段（ru 三形带前后文），以及字面组保留花括号（作者期噪音可见）", () => {
		expect(formatTemplate("Scopied: {1:{n} символ|2:{n} символа|5:{n} символов}", { n: 3 }, "ru-RU")).toBe("Scopied: 3 символа");
		expect(formatTemplate("{─…}", {}, "zh-CN")).toBe("{─…}");
	});
});

describe("m5-i18n 运行时：复数类与标签归一", () => {
	it("pluralCategory：ru 三类 / en 两类 / zh 单类；11/12-14 例外", () => {
		expect(pluralCategory("ru-RU", 1)).toBe("one");
		expect(pluralCategory("ru-RU", 3)).toBe("few");
		expect(pluralCategory("ru-RU", 11)).toBe("many");
		expect(pluralCategory("ru-RU", 112)).toBe("many");
		expect(pluralCategory("ru-RU", 122)).toBe("few");
		expect(pluralCategory("en-US", 1)).toBe("one");
		expect(pluralCategory("en-US", 0)).toBe("other");
		expect(pluralCategory("zh-CN", 1)).toBe("other");
	});

	it("normalizeLocaleTag：Hans/Hant 分族、六语裸码补全、en 折叠、区域大写", () => {
		expect(normalizeLocaleTag(undefined)).toBe("en-US");
		expect(normalizeLocaleTag("zh")).toBe("zh-CN");
		expect(normalizeLocaleTag("zh_CN")).toBe("zh-CN");
		expect(normalizeLocaleTag("zh-Hans-SG")).toBe("zh-CN");
		expect(normalizeLocaleTag("zh-TW")).toBe("zh-TW");
		expect(normalizeLocaleTag("zh-Hant-HK")).toBe("zh-TW");
		expect(normalizeLocaleTag("en")).toBe("en-US");
		expect(normalizeLocaleTag("en_GB")).toBe("en-US");
		expect(normalizeLocaleTag("ja")).toBe("ja-JP");
		expect(normalizeLocaleTag("ko-KR")).toBe("ko-KR");
		expect(normalizeLocaleTag("ru")).toBe("ru-RU");
		expect(normalizeLocaleTag("fr_fr")).toBe("fr-FR");
	});
});

describe("m5-i18n 运行时：解析链与 t 实例", () => {
	const tables: Record<string, { "a.hello"?: string; "a.enOnly"?: string }> = {
		"zh-CN": { "a.hello": "你好 {n}" },
		"zh-TW": {},
		"en-US": { "a.hello": "hello {n}", "a.enOnly": "only {n}" },
	};

	it("chainFor：zh-TW 经 zh-CN；en-US 单链；其余 active → en-US", () => {
		expect(chainFor("zh-TW")).toEqual(["zh-TW", "zh-CN", "en-US"]);
		expect(chainFor("en-US")).toEqual(["en-US"]);
		expect(chainFor("ja-JP")).toEqual(["ja-JP", "en-US"]);
	});

	it("createT：命中按表渲染；zh-TW 缺键落 zh-CN；全缺 → fallback → key；setTag 热切", () => {
		const t = createT({ tag: "zh-CN", getTable: (tag) => tables[tag] });
		expect(t("a.hello", { n: 1 })).toBe("你好 1");
		t.setTag("zh-TW");
		expect(t("a.hello", { n: 1 })).toBe("你好 1"); // 繁体缺键蹦简体（P3 特例）
		expect(t("a.enOnly", { n: 2 })).toBe("only 2");
		t.setTag("en-US");
		expect(t("a.enOnly", { n: 2 })).toBe("only 2");
		expect(t("a.missing", undefined, "兜底文案")).toBe("兜底文案");
		expect(t("a.missing")).toBe("a.missing");
	});
});

describe("m5-i18n 地板目录", () => {
	it("三语键集一致（18 键）；failReason 族按链解析", () => {
		expect(Object.keys(floorZhCN).sort()).toEqual(Object.keys(floorZhTW).sort());
		expect(Object.keys(floorZhCN).sort()).toEqual(Object.keys(floorEnUS).sort());
		expect(floorKeys.length).toBe(18);
		expect(Object.keys(floorCatalogs).sort()).toEqual(["en-US", "zh-CN", "zh-TW"]);
		const t = createFloorT("zh-CN");
		expect(t("core.kernel.disabled")).toBe("未启用（defaultEnabled=false 或配置/CLI 禁用，§5.4）");
		expect(t("core.activate.err.cascade", { key: "skill.catalog", name: "skill" })).toBe(
			'硬依赖能力 "skill.catalog" 的提供者 skill 已降级（级联降级）',
		);
		const en = createFloorT("en-US");
		expect(en("core.context.model")).toBe("Model: (not configured)");
		expect(en("core.context.model", { model: "glm" })).toBe("Model: glm");
		// 地板不认识界面键——落 key 本身（D2 缺键静默）
		expect(t("kv.model")).toBe("kv.model");
	});

	it("core.reload.summary 复合模板：failed 段可选组 + 首行参数 + 管道缺省", () => {
		const t = createFloorT("zh-CN");
		expect(t("core.reload.summary", { list: "", n: 3 })).toContain("added 无");
		const out = t("core.reload.summary", { added: "", removed: "", n: 0, name: "m1", reason: "配置校验失败：boom" });
		expect(out).toContain("failed：m1（配置校验失败：boom）…");
	});
});
