/** m5-i18n 界面主目录 · en-US · notices 域（T7：内联 notice/toast/错误行族）。 */
export const enUSNotices: Record<string, string> = {
	"modtoggle.verb": "Mount / unmount",
	"modtoggle.mounted": "Mounted {name} (reload: added {list/none})",
	"modtoggle.unmounted": "Unmounted {name} (reload: removed {list/none})",
	"modtoggle.failed": "{verb} failed: {name} — {reason}",
	"modtoggle.donePartial": "{Mounted/Unmounted} {name}",
	"modtoggle.cascadeFail": "Cascading failures: {list}",
	"moddeps.blockUnmount": "Cannot unmount: {names} is a hard dependency of {hit} (locked)",
	"moddeps.blockMount": "Cannot mount: {hit}, a hard dependency of {names}, cannot be enabled (locked)",
	"replio.noTty": "No interactive terminal (stdin closed) — interactive commands unavailable (D35 fail-closed)",
	"replio.secretSuffix": "{q} (input hidden):",
	"paste.empty": "(No image in the clipboard — take a screenshot and retry, or check terminal permissions)",
	"paste.okHint": "[Image pasted: {name}] — sent with the next message (needs a vision model)",
	"altpaste.attached": "{label} attached — sent with the next message",
	"modtoggle.verbMount": "Mount",
	"modtoggle.verbUnmount": "Unmount",
	"update.banner": "✦ New version {v} available · run orosus upgrade to update",
};
