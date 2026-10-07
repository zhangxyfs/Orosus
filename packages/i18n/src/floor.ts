/**
 * 内核地板目录（m5-i18n T1）——模块系统报错的最小三语表：core 审计 / 挂载 / 降级 / 启动自渲染面。
 * 用途 = 哑系统保险（ROADMAP ①：语言包挂不上、主目录缺失时 failReason 仍有话可说）；
 * 值取自五语译文对照表 core.* 族（表内 ｜ 全角管道在此归一为半角——运行时也认全角，双保险）。
 * 注意：这些是 core 自渲染面；apps/cli 界面主目录（apps/cli/src/locales/）不含 core.* 键。
 */

import type { Messages } from "./runtime.ts";

export const floorZhCN: Messages = {
	"core.activate.err.cascade": '硬依赖能力 "{key}" 的提供者 {name} 已降级（级联降级）',
	"core.activate.err.noProvide": '硬依赖能力 "{key}" 未注册：其提供者已激活但未 provide（提供者模块 bug）',
	"core.activate.err.config": "配置校验失败：{error}",
	"core.kernel.err.dupName": "模块名冲突（全局唯一，§5.1）",
	"core.kernel.disabled": "未启用（defaultEnabled=false 或配置/CLI 禁用，§5.4）",
	"core.kernel.err.unknown": "未知（failReason 缺省兜底）",
	"core.loader.err.notObject": "非模块制品：default 导出不是对象（期待 defineModule 的返回值）",
	"core.loader.err.notModule": "非模块制品：缺 name 或 activate（不是 defineModule 形状，§8.4）",
	"core.model.ask.fallback": "model（端点清单拉取失败：{err}——输入全名，或回车用默认 {model|未设}）",
	"core.effort.menu.title": "选择思考档位（{bare}{ · 当前 {cur}}）",
	"core.help.builtin.header": "内建命令：",
	"core.help.alias.header": "别名命令：",
	"core.help.alias.row": "/{short} → {full}{（未安装对应模块）}",
	"core.help.module.header": "模块命令：",
	"core.help.module.empty": "（无）",
	"core.reload.summary":
		"reload 完成：added {list|无} / removed {list|无} / reloaded {list|无} / unchanged {n} / failed{：{name}（{reason 首行}）…| 无}",
	"core.context.model": "模型: {model|（未配置）}",
	"core.context.rest": "窗口: {n} tokens{（{pct}%）} ／ 未知（/provider import --model 可写入） ／ 已用: ~{n} tokens（{pct}%）",
};

export const floorZhTW: Messages = {
	"core.activate.err.cascade": '硬依賴能力 "{key}" 的提供者 {name} 已降級（級聯降級）',
	"core.activate.err.noProvide": '硬依賴能力 "{key}" 未註冊：其提供者已啟用但未 provide（提供者模組 bug）',
	"core.activate.err.config": "設定校驗失敗：{error}",
	"core.kernel.err.dupName": "模組名稱衝突（全域唯一，§5.1）",
	"core.kernel.disabled": "未啟用（defaultEnabled=false 或設定/CLI 停用，§5.4）",
	"core.kernel.err.unknown": "未知（failReason 缺省兜底）",
	"core.loader.err.notObject": "非模組製品：default 匯出不是物件（期待 defineModule 的回傳值）",
	"core.loader.err.notModule": "非模組製品：缺 name 或 activate（不是 defineModule 形狀，§8.4）",
	"core.model.ask.fallback": "model（端點清單拉取失敗：{err}——輸入全名，或按 Enter 用預設 {model|未設}）",
	"core.effort.menu.title": "選擇思考檔位（{bare}{ · 目前 {cur}}）",
	"core.help.builtin.header": "內建命令：",
	"core.help.alias.header": "別名命令：",
	"core.help.alias.row": "/{short} → {full}{（未安裝對應模組）}",
	"core.help.module.header": "模組命令：",
	"core.help.module.empty": "（無）",
	"core.reload.summary":
		"reload 完成：added {list|無} / removed {list|無} / reloaded {list|無} / unchanged {n} / failed{：{name}（{reason 首行}）…| 無}",
	"core.context.model": "模型: {model|（未配置）}",
	"core.context.rest": "視窗: {n} tokens{（{pct}%）} ／ 未知（/provider import --model 可寫入） ／ 已用: ~{n} tokens（{pct}%）",
};

export const floorEnUS: Messages = {
	"core.activate.err.cascade": 'The provider {name} of hard-required capability "{key}" is degraded (cascading degradation)',
	"core.activate.err.noProvide":
		'Hard-required capability "{key}" is not registered: its provider activated but never called provide (provider module bug)',
	"core.activate.err.config": "Configuration validation failed: {error}",
	"core.kernel.err.dupName": "Module name clash (globally unique, §5.1)",
	"core.kernel.disabled": "Not enabled (defaultEnabled=false or disabled via config/CLI, §5.4)",
	"core.kernel.err.unknown": "Unknown (failReason fallback default)",
	"core.loader.err.notObject": "Not a module artifact: the default export is not an object (expected the return value of defineModule)",
	"core.loader.err.notModule": "Not a module artifact: missing name or activate (not a defineModule shape, §8.4)",
	"core.model.ask.fallback": "model (endpoint catalog fetch failed: {err} — type the full name, or press Enter for the default {model|unset})",
	"core.effort.menu.title": "Select thinking effort ({bare}{ · current {cur}})",
	"core.help.builtin.header": "Built-in commands:",
	"core.help.alias.header": "Alias commands:",
	"core.help.alias.row": "/{short} → {full}{ (corresponding module not installed)}",
	"core.help.module.header": "Module commands:",
	"core.help.module.empty": "(None)",
	"core.reload.summary":
		"reload complete: added {list|none} / removed {list|none} / reloaded {list|none} / unchanged {n} / failed{: {name} ({reason 首行})…| none}",
	"core.context.model": "Model: {model|(not configured)}",
	"core.context.rest": "Window: {n} tokens{ ({pct}%)} / unknown (/provider import --model can set it) / Used: ~{n} tokens ({pct}%)",
};

export const floorCatalogs: Readonly<Record<string, Messages>> = {
	"zh-CN": floorZhCN,
	"zh-TW": floorZhTW,
	"en-US": floorEnUS,
};

/** 地板键集（三语 parity 测试与宿主 store 合并用）。 */
export const floorKeys: readonly string[] = Object.keys(floorZhCN);
