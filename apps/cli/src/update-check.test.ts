/** m5-update-check T6：核心件单测——比较器/取数/盘上状态/启动状态机（晚到 toast 闩、stale 续供、幂等）。
 *  HERMETIC：cacheFile 全注入 tmp；fetch 全 mock 零真网络。 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fetchLatestUpdate, fireStartupUpdateCheck, isNewerVersion, markBannerRendered,
	readUpdateState, resetUpdateCheckForTest, shouldSkipStartupCheck, updateInfoNow,
} from "./update-check.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	resetUpdateCheckForTest();
});

const tmp = (): string => {
	dir = mkdtempSync(join(tmpdir(), "orosus-updchk-"));
	return dir;
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const registryResponse = (version: string, integrity?: string): Response =>
	new Response(
		JSON.stringify({ name: "orosus", version, dist: { tarball: `https://registry.npmjs.org/orosus/-/orosus-${version}.tgz`, ...(integrity !== undefined ? { integrity } : {}) } }),
		{ headers: { "content-type": "application/json" } },
	);

describe("isNewerVersion（严格三段数值比较）", () => {
	it("高/等/低与数值序", () => {
		expect(isNewerVersion("0.2.0", "0.1.0")).toBe(true);
		expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
		expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true); // 数值比较非字典序
		expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
		expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
	});
	it("build/prerelease 后缀剥除 + 非三段拒判", () => {
		expect(isNewerVersion("1.0.0+build.9", "0.9.0")).toBe(true);
		expect(isNewerVersion("1.0.0-beta.1", "0.9.0")).toBe(true);
		expect(isNewerVersion("1.0.0", "1.0.0-rc.1")).toBe(false); // 同 triple 不提示
		expect(isNewerVersion("abc", "0.1.0")).toBe(false);
		expect(isNewerVersion("0.1", "0.1.0")).toBe(false);
	});
});

describe("fetchLatestUpdate（注入 fetch + 形状校验 + 静默 err）", () => {
	it("成功解析 version/dist.tarball/integrity", async () => {
		const r = await fetchLatestUpdate({ fetchImpl: (async () => registryResponse("9.9.9", "sha512-abc")) as unknown as typeof fetch });
		expect(r.info?.latest).toBe("9.9.9");
		expect(r.info?.tarball).toContain("orosus-9.9.9.tgz");
		expect(r.info?.integrity).toBe("sha512-abc");
	});
	it("HTTP 非 2xx / 坏形状 / 抛错 → err 人话（不 reject）", async () => {
		expect((await fetchLatestUpdate({ fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch })).err).toContain("HTTP 500");
		expect((await fetchLatestUpdate({ fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch })).err).toBeTruthy();
		expect((await fetchLatestUpdate({ fetchImpl: (async () => { throw new Error("boom"); }) as unknown as typeof fetch })).err).toBe("boom");
	});
});

describe("启动状态机（盘上初值 + 回写 + 晚到 toast 闩 + stale 续供）", () => {
	it("enabled=false：不点火不取数", async () => {
		const d = tmp();
		let called = 0;
		fireStartupUpdateCheck({
			enabled: false,
			lateNotify: () => {},
			cacheFile: join(d, "s.json"),
			fetchImpl: (async () => { called++; return registryResponse("9.9.9"); }) as unknown as typeof fetch,
		});
		await wait(15);
		expect(called).toBe(0);
		expect(updateInfoNow()).toBeUndefined();
	});

	it("网络晚到且横幅未带行 → notify 一次 + 现值回填 + 盘上回写", async () => {
		const cacheFile = join(tmp(), "update-check.json");
		const toasts: string[] = [];
		markBannerRendered(false); // 横幅先渲染（盘上无值 → 未带行）
		fireStartupUpdateCheck({
			enabled: true,
			lateNotify: (l) => toasts.push(l),
			cacheFile,
			fetchImpl: (async () => registryResponse("9.9.9")) as unknown as typeof fetch,
		});
		await wait(25);
		expect(updateInfoNow()?.latest).toBe("9.9.9");
		expect(toasts.length).toBe(1);
		expect(toasts[0]).toContain("9.9.9");
		const state = readUpdateState(cacheFile);
		expect(state?.latest).toBe("9.9.9");
		expect(typeof state?.fetchedAt).toBe("number");
	});

	it("横幅已带行 → 晚到不 toast（只更新现值供循环重入）", async () => {
		const cacheFile = join(tmp(), "update-check.json");
		const toasts: string[] = [];
		markBannerRendered(true);
		fireStartupUpdateCheck({ enabled: true, lateNotify: (l) => toasts.push(l), cacheFile, fetchImpl: (async () => registryResponse("9.9.9")) as unknown as typeof fetch });
		await wait(25);
		expect(toasts.length).toBe(0);
		expect(updateInfoNow()?.latest).toBe("9.9.9");
	});

	it("盘上旧值同步供横幅 + 本次网络失败静默续供（stale-while-error）", async () => {
		const cacheFile = join(tmp(), "update-check.json");
		writeFileSync(cacheFile, JSON.stringify({ fetchedAt: 1, latest: "9.9.9" }), "utf8");
		fireStartupUpdateCheck({ enabled: true, lateNotify: () => {}, cacheFile, fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
		expect(updateInfoNow()?.latest).toBe("9.9.9"); // 点火即有盘上初值（横幅零等待的根基）
		await wait(15);
		expect(updateInfoNow()?.latest).toBe("9.9.9"); // 失败不清旧值
	});

	it("registry 说没有新版 → 现值清空 + 盘上回写真值", async () => {
		const cacheFile = join(tmp(), "update-check.json");
		writeFileSync(cacheFile, JSON.stringify({ fetchedAt: 1, latest: "9.9.9" }), "utf8");
		fireStartupUpdateCheck({ enabled: true, lateNotify: () => {}, cacheFile, fetchImpl: (async () => registryResponse("0.0.1")) as unknown as typeof fetch });
		expect(updateInfoNow()?.latest).toBe("9.9.9"); // 盘上旧值先供
		await wait(25);
		expect(updateInfoNow()).toBeUndefined(); // 网络确证无新版 → 清
		expect(readUpdateState(cacheFile)?.latest).toBe("0.0.1"); // 盘上写真值
	});

	it("重复点火幂等（每进程一次）", async () => {
		const cacheFile = join(tmp(), "update-check.json");
		let called = 0;
		const fetchImpl = (async () => { called++; return registryResponse("9.9.9"); }) as unknown as typeof fetch;
		fireStartupUpdateCheck({ enabled: true, lateNotify: () => {}, cacheFile, fetchImpl });
		fireStartupUpdateCheck({ enabled: true, lateNotify: () => {}, cacheFile, fetchImpl });
		await wait(25);
		expect(called).toBe(1);
	});

	it("晚到 toast 只发一次（闩）", async () => {
		const cacheFile = join(tmp(), "update-check.json");
		const toasts: string[] = [];
		markBannerRendered(false);
		fireStartupUpdateCheck({ enabled: true, lateNotify: (l) => toasts.push(l), cacheFile, fetchImpl: (async () => registryResponse("9.9.9")) as unknown as typeof fetch });
		await wait(25);
		expect(toasts.length).toBe(1);
	});
});

describe("shouldSkipStartupCheck（头less 启动判定）", () => {
	it("--print/-p/--version/-v/子命令词跳过；空与纯旗标不跳", () => {
		expect(shouldSkipStartupCheck(["--print", "hi"])).toBe(true);
		expect(shouldSkipStartupCheck(["-p", "hi"])).toBe(true);
		expect(shouldSkipStartupCheck(["--version"])).toBe(true);
		expect(shouldSkipStartupCheck(["-v"])).toBe(true);
		expect(shouldSkipStartupCheck(["provider", "list"])).toBe(true);
		expect(shouldSkipStartupCheck(["upgrade"])).toBe(true);
		expect(shouldSkipStartupCheck([])).toBe(false);
		expect(shouldSkipStartupCheck(["--model", "custom/glm"])).toBe(false);
	});
});
