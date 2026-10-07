/** m5-update-check T4：`orosus upgrade` 自升级子命令（D3）——查询 → [y/N] 确认 → 真进度条流式
 *  下载 tarball（registry 自带 SRI sha512 校验）→ npm/pnpm install -g 安装 → 完成感谢文案。
 *  文案全 i18n（读 config 顶层 language 键；语言包语种子命令形态回落系统检测三语——D7 已知局限：
 *  包槽需图装配，子命令不装）。与自动检测（update-check.ts）独立取数：不受 [update] check 开关
 *  影响（D4）；dev 形态提示 git pull 不自升（D6）；非 TTY 不交互不安装、打印升级命令退出 0（D9）。
 *  io 全注入（fetch/confirm/install/isTTY/currentVersion/路径）——测试零真网络零 spawn。 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { OROSUS_USER_AGENT, OROSUS_VERSION } from "@orosus/contracts/version";
import { loadConfig } from "@orosus/core";
import { bindBuiltinLocale, t } from "./i18n/app.ts";
import { detectSystemLocale } from "./i18n/index.ts";
import { question } from "./repl-io.ts";
import { fetchLatestUpdate, isNewerVersion } from "./update-check.ts";

const BUILTIN_TAGS: readonly string[] = ["zh-CN", "zh-TW", "en-US"];

/** 子命令语言绑定：config 顶层 language 键（harness 同源读法）> 系统检测；非内置语种回落系统检测（D7）。 */
function bindUpgradeLocale(configPath: string): void {
	let tag: string | undefined;
	try {
		const v = loadConfig({ userFile: configPath }).core.language;
		tag = typeof v === "string" ? v : undefined;
	} catch {
		/* 坏盘回落系统检测 */
	}
	bindBuiltinLocale(tag !== undefined && BUILTIN_TAGS.includes(tag) ? tag : detectSystemLocale());
}

export function isUpgradeSubcommand(argv: string[]): boolean {
	return argv[0] === "upgrade";
}

export interface UpgradeCmdIo {
	out(line: string): void;
	configPath: string;
	tmpDir: string;
	fetchImpl?: typeof fetch | undefined;
	/** 确认问询（缺省 readline question；EOF/异常 = 拒绝——stdin EOF 的 reject 视作退出，已知坑）。 */
	confirm?: (prompt: string) => Promise<boolean>;
	/** 安装执行器（缺省 spawn npm/pnpm + shell:true——win32 下 npm 是 .cmd，裸 spawn EINVAL，m4-3c 实锚）。 */
	install?: (tgz: string, meta: { latest: string; manager: "npm" | "pnpm" }) => Promise<{ code: number; output: string }>;
	isTTY?: boolean;
	/** 当前版本（缺省 OROSUS_VERSION；测试注入走分支——常量不可变）。 */
	currentVersion?: string;
	/** 进度渲染（缺省 stdout \r 单行；测试注入收集）。 */
	progress?: (text: string) => void;
}

/** pnpm 安装推断（D8）：resolve 路径含 pnpm → pnpm add -g；否则（含兜底形态）默认 npm。 */
export function detectPackageManager(fromUrl = import.meta.url): "npm" | "pnpm" {
	try {
		const p = createRequire(fromUrl).resolve("orosus/package.json");
		if (/pnpm[/\\]/i.test(p)) return "pnpm";
	} catch {
		/* 读不到 → npm */
	}
	return "npm";
}

const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** 下载进度条单行（语言中性，22 格）：[██████░░░░░░] 45% · 512KB/1.1MB；无总长 → 已下载字节。 */
export function renderProgress(loaded: number, total: number | undefined): string {
	const BAR = 22;
	if (total === undefined || total <= 0) return `[ downloading ${fmtBytes(loaded)} ]`;
	const filled = Math.min(BAR, Math.round((loaded / total) * BAR));
	const pct = Math.min(100, Math.round((loaded / total) * 100));
	return `[${"█".repeat(filled)}${"░".repeat(BAR - filled)}] ${pct}% · ${fmtBytes(loaded)}/${fmtBytes(total)}`;
}

/** 确认词判定：y 开头即认（y/yes/yy 宽容——2026-10-07 真机用户打 yy 实锚）；空/n/no 拒。 */
export const isYes = (s: string): boolean => /^y/i.test(s.trim());

// 复用 repl-io 询问原语（askActive 行归询问语义）——不自建 readline：同 stdin 双 Interface 双回显
// （真机实锚打一个 y 显两个）且绕开行队列/EOF 竞速兜底；Esc 取消（ESC_CANCELLED）与 EOF（noTty）
// 一律 catch 成拒绝
const defaultConfirm = async (prompt: string): Promise<boolean> => {
	try {
		return isYes(await question(prompt));
	} catch {
		return false;
	}
};

const defaultInstall = (tgz: string, meta: { latest: string; manager: "npm" | "pnpm" }): Promise<{ code: number; output: string }> =>
	new Promise((resolve) => {
		// shell:true 直拼命令串（win32 npm/pnpm 皆 .cmd）；tgz 路径带引号防 home 目录空格
		const cmdLine = meta.manager === "pnpm" ? `pnpm add -g "${tgz}"` : `npm install -g "${tgz}"`;
		const child = spawn(cmdLine, { shell: true });
		let output = "";
		child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
		child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
		child.on("error", (e) => resolve({ code: 1, output: String(e) }));
		child.on("close", (code) => resolve({ code: code ?? 1, output }));
	});

/** 流式下载 tarball 进内存（MB 级，进程内一次性的临时数据）；边下边推进度。 */
async function downloadTarball(url: string, opts: { fetchImpl?: typeof fetch | undefined; progress?: (text: string) => void }): Promise<Buffer> {
	const doFetch = opts.fetchImpl ?? fetch;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 60_000); // 手控超时（fetchLatestUpdate 同款：清句柄防 exit 撕）
	try {
		const res = await doFetch(url, { headers: { "user-agent": OROSUS_USER_AGENT }, signal: ac.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		if (res.body === null) throw new Error("empty body");
		const totalHeader = res.headers.get("content-length");
		const total = totalHeader !== null && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined;
		const chunks: Buffer[] = [];
		let loaded = 0;
		for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
			const b = Buffer.from(chunk);
			chunks.push(b);
			loaded += b.length;
			opts.progress?.(renderProgress(loaded, total));
		}
		return Buffer.concat(chunks);
	} finally {
		clearTimeout(timer);
	}
}

/** SRI sha512-<base64> 校验；registry 未带 integrity → 放行（老端点兼容）。 */
function verifyIntegrity(buf: Buffer, integrity: string | undefined): boolean {
	if (integrity === undefined) return true;
	const m = /^sha512-(.+)$/.exec(integrity);
	if (m === null) return false;
	return createHash("sha512").update(buf).digest("base64") === m[1];
}

const outputTail = (s: string): string => {
	const lines = s.trim().split(/\r?\n/);
	return lines.slice(-6).join(" | ");
};

/** 主流程：返回进程退出码（0 = 成功/无需操作；1 = 检查/下载/校验/安装失败；2 = 参数错）。 */
export async function runUpgradeSubcommand(argv: string[], io: UpgradeCmdIo): Promise<number> {
	bindUpgradeLocale(io.configPath);
	if (argv.length > 1) {
		io.out(t("upgrade.unknownArg", { a: argv.slice(1).join(" "), usage: t("upgrade.usage") }));
		return 2;
	}
	const current = io.currentVersion ?? OROSUS_VERSION;
	if (current === "0.0.0-dev") {
		io.out(t("upgrade.devForm"));
		return 0;
	}
	const r = await fetchLatestUpdate({ fetchImpl: io.fetchImpl });
	if (r.info === undefined) {
		io.out(t("upgrade.checkFail", { err: r.err ?? "" }));
		return 1;
	}
	const info = r.info;
	if (!isNewerVersion(info.latest, current)) {
		io.out(t("upgrade.upToDate", { v: current }));
		return 0;
	}
	if (!(io.isTTY ?? process.stdout.isTTY === true)) {
		io.out(t("upgrade.headless", { cur: current, latest: info.latest }));
		return 0;
	}
	const yes = await (io.confirm ?? defaultConfirm)(t("upgrade.confirm", { cur: current, latest: info.latest }));
	if (!yes) {
		io.out(t("upgrade.declined", { v: current }));
		return 0;
	}
	const progress = io.progress ?? ((text: string) => { process.stdout.write(`\r${text}`); });
	let buf: Buffer;
	try {
		buf = await downloadTarball(info.tarball, { fetchImpl: io.fetchImpl, progress });
	} catch (err) {
		io.out(t("upgrade.downloadFail", { err: err instanceof Error ? err.message : String(err) }));
		return 1;
	}
	if (io.progress === undefined) process.stdout.write(`\r${" ".repeat(72)}\r`); // 清进度残影（\r 覆盖行）
	if (!verifyIntegrity(buf, info.integrity)) {
		io.out(t("upgrade.integrityFail", { v: info.latest }));
		return 1;
	}
	mkdirSync(io.tmpDir, { recursive: true });
	const tgz = join(io.tmpDir, `orosus-${info.latest}.tgz`);
	writeFileSync(tgz, buf);
	io.out(t("upgrade.installing"));
	const install = await (io.install ?? defaultInstall)(tgz, { latest: info.latest, manager: detectPackageManager() });
	try {
		rmSync(tgz, { force: true }); // 临时件清理（失败不阻断）
	} catch {
		/* 只读 fs 等 */
	}
	if (install.code !== 0) {
		io.out(t("upgrade.installFail", { err: outputTail(install.output) }));
		if (/EBUSY|EPERM/i.test(install.output)) io.out(t("upgrade.busyHint")); // 其他实例占用（D8：提示不重试）
		return 1;
	}
	io.out(t("upgrade.done", { v: info.latest }));
	return 0;
}
