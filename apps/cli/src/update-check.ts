/** m5-update-check（方案 docs/superpowers/plans/2026-10-07-m5-update-check.md）：启动期更新检测。
 *  D2：每启动联网查一次（不节流）；盘上状态文件存「上次已知最新版」——横幅行启动即从盘上值渲染，
 *  本次检查失败静默、旧值续供（stale-while-error，catalog.ts 盘上信封同款）。
 *  自动检测受 [update] check 开关（update-settings.ts，缺省开）与 dev 形态（0.0.0-dev）约束；
 *  orosus upgrade 手动口（upgrade-cmd.ts）独立取数、不受开关影响（D4）。
 *  失败全程静默——横幅行缺席/保持旧值即全部反馈，永不炸启动。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OROSUS_USER_AGENT, OROSUS_VERSION } from "@orosus/contracts/version";
import { orosusHome } from "@orosus/contracts/home";
import { t } from "./i18n/app.ts";

export interface UpdateInfo { latest: string; tarball: string; integrity?: string }
export interface UpdateFetchResult { info?: UpdateInfo; err?: string }

export const UPDATE_REGISTRY_URL = "https://registry.npmjs.org/orosus/latest";
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** 状态文件缺省落点（~/.orosus/cache/update-check.json）——宿主接线用；测试注入 tmp 保密封离。 */
export function defaultUpdateStateFile(): string {
	return join(orosusHome(), "cache", "update-check.json");
}

/** 盘上信封：{ fetchedAt, latest }。坏 JSON/坏形状 → undefined（忽略不炸）。 */
interface UpdateState { fetchedAt: number; latest: string }

export function readUpdateState(path: string): UpdateState | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { fetchedAt?: unknown; latest?: unknown };
		if (typeof parsed.fetchedAt !== "number" || typeof parsed.latest !== "string" || parsed.latest === "") return undefined;
		return { fetchedAt: parsed.fetchedAt, latest: parsed.latest };
	} catch {
		return undefined;
	}
}

function writeUpdateState(path: string, latest: string, fetchedAt: number = Date.now()): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ fetchedAt, latest }), "utf8");
	} catch {
		// 落盘失败（只读文件系统等）不阻断——下次启动重查即回填（缓存是增强不是前提）
	}
}

/** 严格 x.y.z 三段数值比较（build/prerelease 后缀剥除；同 triple 不提示；任一非三段 → false）。 */
export function isNewerVersion(latest: string, current: string): boolean {
	const parts = (v: string): number[] => {
		const nums = v.split("+")[0]!.split("-")[0]!.split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : Number.NaN));
		return nums.length === 3 ? nums : [Number.NaN];
	};
	const a = parts(latest);
	const b = parts(current);
	if (a.some((n) => Number.isNaN(n)) || b.some((n) => Number.isNaN(n))) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i]! > b[i]!) return true;
		if (a[i]! < b[i]!) return false;
	}
	return false;
}

/** registry /latest 取数（catalog.ts 同款：10s 超时 + fetchImpl 注入 + 形状校验）。
 *  返回 { info } 成功 / { err } 人话失败因——横幅路径忽略 err，upgrade 子命令展示。 */
export async function fetchLatestUpdate(opts: { fetchImpl?: typeof fetch | undefined; registryUrl?: string } = {}): Promise<UpdateFetchResult> {
	const doFetch = opts.fetchImpl ?? fetch;
	// 手控超时 + finally 清句柄——AbortSignal.timeout 成功后定时器悬挂，子命令路径 process.exit
	// 撕句柄触发 libuv 断言（win32 实测 2026-10-07；catalog 同款写法在常驻进程无此面）
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), UPDATE_CHECK_TIMEOUT_MS);
	try {
		const res = await doFetch(opts.registryUrl ?? UPDATE_REGISTRY_URL, {
			headers: { accept: "application/json", "user-agent": OROSUS_USER_AGENT },
			signal: ac.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const doc = (await res.json()) as { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } };
		if (typeof doc.version !== "string" || typeof doc.dist?.tarball !== "string") throw new Error("unexpected registry payload shape");
		return {
			info: {
				latest: doc.version,
				tarball: doc.dist.tarball,
				...(typeof doc.dist.integrity === "string" ? { integrity: doc.dist.integrity } : {}),
			},
		};
	} catch (err) {
		return { err: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
	}
}

// ---------- 启动期状态机（每进程一次） ----------

/** 头less 启动形态判定：--print/-p、--version/-v、子命令词——自动检测跳过（upgrade 子命令自带取数）。 */
const SUBCOMMAND_WORDS = ["provider", "sessions", "home", "module", "upgrade"];
export function shouldSkipStartupCheck(argv: string[]): boolean {
	return argv.includes("--print") || argv.includes("-p") || argv.includes("--version") || argv.includes("-v")
		|| SUBCOMMAND_WORDS.includes(argv[0] ?? "");
}

let fired = false;
let settled: UpdateInfo | undefined; // 「确有新版」现值（盘上初值 + 网络回填）；无新版/未点火 = undefined
let bannerDone = false;
let bannerHasLine = false;
let lateToasted = false;

/** 测试专用：清模块级状态（模拟新进程）。 */
export function resetUpdateCheckForTest(): void {
	fired = false;
	settled = undefined;
	bannerDone = false;
	bannerHasLine = false;
	lateToasted = false;
}

/** 启动点火（main.ts 在代理接线后调）：读盘供横幅初值 → 后台 fetch → 成功回写盘；
 *  横幅已渲染且未带行时查到新版 → notify toast 一次（晚到兜底，D5）。重复调用幂等（每进程一次）。 */
export function fireStartupUpdateCheck(opts: { enabled: boolean; lateNotify: (line: string) => void; cacheFile?: string; fetchImpl?: typeof fetch | undefined }): void {
	if (fired) return;
	fired = true;
	if (!opts.enabled) return;
	const cacheFile = opts.cacheFile ?? defaultUpdateStateFile();
	const disk = readUpdateState(cacheFile);
	if (disk !== undefined && isNewerVersion(disk.latest, OROSUS_VERSION)) settled = { latest: disk.latest, tarball: "" };
	void fetchLatestUpdate({ fetchImpl: opts.fetchImpl }).then((r) => {
		if (r.info === undefined) return; // 失败静默——盘上旧值（若有）继续供横幅行
		writeUpdateState(cacheFile, r.info.latest);
		if (isNewerVersion(r.info.latest, OROSUS_VERSION)) {
			settled = r.info;
			if (bannerDone && !bannerHasLine && !lateToasted) {
				lateToasted = true;
				opts.lateNotify(t("update.banner", { v: r.info.latest }));
			}
		} else {
			settled = undefined; // registry 说没有新版（本地新于 registry/回滚）——下次循环起横幅不再渲染
		}
	});
}

/** 横幅行现值（盘上初值或网络已回填）——undefined = 无新版或未点火。 */
export function updateInfoNow(): UpdateInfo | undefined {
	return settled;
}

/** 横幅渲染闩（只记首帧）：hasLine = 首次横幅是否已带更新行（网络晚到 toast 的判定依据）。 */
export function markBannerRendered(hasLine: boolean): void {
	if (bannerDone) return;
	bannerDone = true;
	bannerHasLine = hasLine;
}
