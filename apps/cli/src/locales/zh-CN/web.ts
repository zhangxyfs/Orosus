/** web GUI 界面键区（2026-10-16 web i18n 批）：控件窗前端专用——与 TUI/CLI 键区零共享（spec §2 两套独立）。
 *  zh-CN 是源语；繁/英/日/韩/俄译值取自五语对照表（specs/i18n-translations/ta|tb-zone-w-*.md——已全量落库）。 */
import type { Messages } from "@orosus/i18n";

export const zhCNWeb: Messages = {
	"web.shell.settings": "设置",
	"web.shell.help": "帮助",
	"web.shell.helpTitle": "帮助（/help）",
	"web.shell.more": "更多",
	"web.shell.moreTitle": "更多：诊断 / 模块总览 / 钩子注入 / 压缩摘要（TUI 的 Ctrl+E/P/H/O，浏览器键位冲突故入口在此）",
	"web.common.loading": "加载中…",
	"web.common.retry": "重试",
	"web.settings.langSwitched": "语言已切换",
	"web.settings.langAlready": "当前已是该语言",
	"web.settings.langNoSession": "暂无当前会话——语言切换需要会话承载（先新建或选择一个会话）",
	"web.toast.switchFail": "切换失败：",
	/* web-i18n E1：api.js 断连面（ta-zone-w-1 简体列——三主侧平行落，ja/ko/ru 由 C2 gen 收口） */
	"web.disconnect.retry": "重试连接",
	"web.disconnect.title": "与 Orosus server 的连接已断开",
	"web.disconnect.retrying": "正在重试…",
	"web.disconnect.closedTitle": "server 已正常关闭",
	"web.disconnect.closedBody": "server 进程已正常退出（收到关闭信号）。<br>",
	"web.disconnect.closedHint": "请回到终端重新运行 <b>orosus web</b>（或 TUI 中 <b>/web</b>），然后点击重试或刷新本页。",
	"web.disconnect.portHint": "<div class=\"dim disc-hint\">若重试持续失败，server 可能已换用新端口——请以终端最新打印的网址打开。</div>",
	"web.disconnect.noTokenTitle": "本页缺少访问令牌",
	"web.disconnect.noTokenBody": "本页未携带访问令牌（token）。<br>",
	"web.disconnect.noTokenHint": "请回到终端查看 <b>orosus web</b> 打印的网址（含 <b>?token=</b> 参数），用该网址打开本页。",
	"web.disconnect.noTokenNote": "<div class=\"dim disc-hint\">令牌只在首次打开时随网址带入，随后保存在本标签页会话存储中。</div>",
	"web.disconnect.exitedBody": "server 进程可能已退出（终端被关闭或已 Ctrl+C）。<br>",
	/* web-i18n E2：dialog.js 控件面（ta-zone-w-1 简体列——三主侧平行落，ja/ko/ru 由 C2 gen 收口） */
	"web.dialog.closeEsc": "<button class=\"dlg-x\" type=\"button\" aria-label=\"关闭（Esc）\">✕</button></div>",
	"web.common.empty": "（空）",
};
