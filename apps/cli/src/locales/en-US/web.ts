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
	/* web-i18n E1: api.js disconnect surface (ta-zone-w-1 English column — three main sides in parallel; ja/ko/ru land via C2 gen) */
	"web.disconnect.retry": "Reconnect",
	"web.disconnect.title": "Disconnected from the Orosus server",
	"web.disconnect.retrying": "Retrying…",
	"web.disconnect.closedTitle": "Server closed normally",
	"web.disconnect.closedBody": "The server process exited normally (shutdown signal received).<br>",
	"web.disconnect.closedHint": "Return to the terminal, run <b>orosus web</b> again (or <b>/web</b> in the TUI), then click Retry or refresh this page.",
	"web.disconnect.portHint": "<div class=\"dim disc-hint\">If retries keep failing, the server may have switched to a new port — open the URL most recently printed in the terminal.</div>",
	"web.disconnect.noTokenTitle": "This page is missing the access token",
	"web.disconnect.noTokenBody": "This page carries no access token.<br>",
	"web.disconnect.noTokenHint": "Return to the terminal, take the URL printed by <b>orosus web</b> (it includes the <b>?token=</b> parameter) and open this page with it.",
	"web.disconnect.noTokenNote": "<div class=\"dim disc-hint\">The token rides in the URL only on first open; afterwards it is kept in this tab's session storage.</div>",
	"web.disconnect.exitedBody": "The server process may have exited (terminal closed or Ctrl+C pressed).<br>",
	/* web-i18n E2: dialog.js widget surface (ta-zone-w-1 English column — three main sides in parallel; ja/ko/ru land via C2 gen) */
	"web.dialog.closeEsc": "<button class=\"dlg-x\" type=\"button\" aria-label=\"Close (Esc)\">✕</button></div>",
	"web.common.empty": "(empty)",
};
