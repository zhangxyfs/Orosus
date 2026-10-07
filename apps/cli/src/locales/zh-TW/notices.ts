/** m5-i18n 界面主目录 · zh-TW · notices 域（T7：内联 notice/toast/错误行族）。 */
export const zhTWNotices: Record<string, string> = {
	"modtoggle.verb": "掛載 / 卸載",
	"modtoggle.mounted": "已掛載 {name}（reload：added {list/無}）",
	"modtoggle.unmounted": "已卸載 {name}（reload：removed {list/無}）",
	"modtoggle.failed": "{verb}失敗：{name}——{reason}",
	"modtoggle.donePartial": "已{verb} {name}",
	"modtoggle.cascadeFail": "連帶失敗：{list}",
	"moddeps.blockUnmount": "無法卸載：{names} 被 {hit}（鎖定）硬相依",
	"moddeps.blockMount": "無法掛載：{names} 硬相依的 {hit}（鎖定）不可啟用",
	"replio.noTty": "無互動環境（stdin 已關閉）——互動式命令不可用（D35 fail-closed）",
	"replio.secretSuffix": "{q}（輸入不回顯）:",
	"paste.empty": "（剪貼簿中沒有圖片——截圖後重試，或檢查終端機權限）",
	"paste.okHint": "[已貼上圖片: {name}]——將隨下一條訊息傳送（需 vision 模型）",
	"altpaste.attached": "{label} 已掛接——將隨下一條訊息傳送",
	"modtoggle.verbMount": "掛載",
	"modtoggle.verbUnmount": "卸載",
	"update.banner": "✦ 新版本 {v} 可用 · 在終端執行 orosus upgrade 升級",
};
