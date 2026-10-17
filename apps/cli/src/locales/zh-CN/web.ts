/** web GUI 界面键区（2026-10-16 web i18n 批）：控件窗前端专用——与 TUI/CLI 键区零共享（spec §2 两套独立）。
 *  zh-CN 是源语；繁/英/日/韩/俄译值取自五语对照表（specs/i18n-translations/ta|tb-zone-w-*.md——已全量落库）。 */
import type { Messages } from "@orosus/i18n";

export const zhCNWeb: Messages = {
	"web.shell.settings": "设置",
	"web.shell.help": "帮助",
	"web.shell.more": "更多",
	"web.common.loading": "加载中…",
	"web.common.retry": "重试",
	"web.settings.langSwitched": "语言已切换",
};
