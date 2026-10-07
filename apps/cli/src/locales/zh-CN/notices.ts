/** m5-i18n 界面主目录 · zh-CN · notices 域（T7：内联 notice/toast/错误行族）。 */
export const zhCNNotices: Record<string, string> = {
	"modtoggle.verb": "挂载 / 卸载",
	"modtoggle.mounted": "已挂载 {name}（reload：added {list/无}）",
	"modtoggle.unmounted": "已卸载 {name}（reload：removed {list/无}）",
	"modtoggle.failed": "{verb}失败：{name}——{reason}",
	"modtoggle.donePartial": "已{verb} {name}",
	"modtoggle.cascadeFail": "连带失败：{list}",
	"moddeps.blockUnmount": "无法卸载：{names} 被 {hit}（锁定）硬依赖",
	"moddeps.blockMount": "无法挂载：{names} 硬依赖的 {hit}（锁定）不可启用",
	"replio.noTty": "无交互环境（stdin 已关闭）——交互式命令不可用（D35 fail-closed）",
	"replio.secretSuffix": "{q}（输入不回显）:",
	"paste.empty": "（剪贴板中没有图片——截图后重试，或检查终端权限）",
	"paste.okHint": "[已粘贴图片: {name}]——将随下一条消息发送（需 vision 模型）",
	"altpaste.attached": "{label} 已挂接——将随下一条消息发送",
	"modtoggle.verbMount": "挂载",
	"modtoggle.verbUnmount": "卸载",
};
