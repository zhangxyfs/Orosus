import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";

/** 模块启停行级写（2026-09-23 模块热插拔）：config.toml 的 [模块名] 节内写/改 enabled 行。
 *  行级而非 smol-toml 文档级重写：stringify 会洗掉用户注释与键序（/model 写盘同教训——行级写 TOML
 *  必须节区感知：节存在则节内改/插（下一节头之前），节不存在则文件尾新建节；保文件原行尾风格）。
 *  写用户层 config（~/.orosus/config.toml——模块启停是用户级偏好，跨项目生效）。 */
export function setModuleEnabledInConfig(name: string, enabled: boolean, filePath = join(orosusHome(), "config.toml")): void {
	let raw = "";
	try {
		raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""); // BOM 剥离
	} catch {
		/* 缺文件从空起 */
	}
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const lines = raw === "" ? [] : raw.split(/\r?\n/);
	// 末尾空行残留处理：split 出的尾空串保留位置感，写回时自然还原
	const sectionRe = /^\s*\[\s*([^\]#]+?)\s*\]/;
	let inSection = false;
	let insertAt = -1;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(sectionRe);
		if (m !== null) {
			if (inSection) { insertAt = i; break; } // 到下一节头——enabled 插在上一节尾
			inSection = m[1] === name;
		} else if (inSection && /^\s*enabled\s*=/.test(lines[i]!)) {
			lines[i] = `enabled = ${enabled}`;
			writeFileSync(filePath, lines.join(eol), "utf8");
			return;
		}
	}
	if (inSection && insertAt === -1) insertAt = lines.length; // 目标节是最后一节——文件尾插
	if (insertAt === -1) {
		// 节不存在——文件尾新建（前留空行隔开既有内容）
		if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
		lines.push(`[${name}]`, `enabled = ${enabled}`);
	} else {
		lines.splice(insertAt, 0, `enabled = ${enabled}`);
	}
	writeFileSync(filePath, lines.join(eol), "utf8");
}
