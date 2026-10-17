/** web GUI 界面键区（2026-10-16 web i18n 批）：控件窗前端专用——与 TUI/CLI 键区零共享（spec §2 两套独立）。
 *  英文译值取自五语对照表 A 表（specs/i18n-translations/ta-zone-w-*.md——已全量落库）。 */
import type { Messages } from "@orosus/i18n";

export const enUSWeb: Messages = {
	"web.shell.settings": "Settings",
	"web.shell.help": "Help",
	"web.shell.helpTitle": "Help (/help)",
	"web.shell.more": "More",
	"web.shell.moreTitle": "More: diagnostics / module overview / hook injections / compaction summary (TUI's Ctrl+E/P/H/O — keys conflict in the browser, so the entries live here)",
	"web.common.loading": "Loading…",
	"web.common.retry": "Retry",
	"web.settings.langSwitched": "Language switched",
	"web.settings.langAlready": "Already this language",
	"web.settings.langNoSession": "No current session — language switching needs a session to land on (create or select one first)",
	"web.toast.switchFail": "Switch failed: ",
};
