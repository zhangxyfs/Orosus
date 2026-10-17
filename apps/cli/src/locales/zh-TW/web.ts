/** web GUI 界面键区（2026-10-16 web i18n 批）：控件窗前端专用——与 TUI/CLI 键区零共享（spec §2 两套独立）。
 *  繁体译值取自五语对照表 A 表（specs/i18n-translations/ta-zone-w-*.md——已全量落库）。 */
import type { Messages } from "@orosus/i18n";

export const zhTWWeb: Messages = {
	"web.shell.settings": "設定",
	"web.shell.help": "說明",
	"web.shell.helpTitle": "說明（/help）",
	"web.shell.more": "更多",
	"web.shell.moreTitle": "更多：診斷 / 模組總覽 / 鉤子注入 / 壓縮摘要（TUI 的 Ctrl+E/P/H/O，瀏覽器鍵位衝突故入口在此）",
	"web.common.loading": "載入中…",
	"web.common.retry": "重試",
	"web.settings.langSwitched": "語言已切換",
	"web.settings.langAlready": "目前已是該語言",
	"web.settings.langNoSession": "暫無目前工作階段——語言切換需要工作階段承載（先新增或選擇一個工作階段）",
	"web.toast.switchFail": "切換失敗：",
	/* web-i18n E1：api.js 斷連面（ta-zone-w-1 繁體列——三主側平行落，ja/ko/ru 由 C2 gen 收口） */
	"web.disconnect.retry": "重試連線",
	"web.disconnect.title": "與 Orosus server 的連線已斷開",
	"web.disconnect.retrying": "正在重試…",
	"web.disconnect.closedTitle": "server 已正常關閉",
	"web.disconnect.closedBody": "server 處理程序已正常結束（收到關閉訊號）。<br>",
	"web.disconnect.closedHint": "請回到終端機重新執行 <b>orosus web</b>（或 TUI 中 <b>/web</b>），然後點擊重試或重新整理本頁。",
	"web.disconnect.portHint": "<div class=\"dim disc-hint\">若重試持續失敗，server 可能已換用新連接埠——請以終端最新列印的網址開啟。</div>",
	"web.disconnect.noTokenTitle": "本頁缺少存取權杖",
	"web.disconnect.noTokenBody": "本頁未攜帶存取權杖（token）。<br>",
	"web.disconnect.noTokenHint": "請回到終端機查看 <b>orosus web</b> 列印的網址（含 <b>?token=</b> 參數），用該網址開啟本頁。",
	"web.disconnect.noTokenNote": "<div class=\"dim disc-hint\">權杖只在首次開啟時隨網址帶入，隨後儲存在本分頁的工作階段儲存區中。</div>",
	"web.disconnect.exitedBody": "server 處理程序可能已結束（終端被關閉或已 Ctrl+C）。<br>",
};
