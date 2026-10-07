/** m5-update-check T6：upgrade 子命令分支全测——零真网络零真 spawn（fetch/confirm/install 全注入）。
 *  语言钉 zh-CN（临时 config 写 language 键）防 detectSystemLocale 环境漂移；currentVersion 注入
 *  走分支（OROSUS_VERSION 常量不可变）。 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { detectPackageManager, isUpgradeSubcommand, renderProgress, runUpgradeSubcommand, type UpgradeCmdIo } from "./upgrade-cmd.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

const TARBALL = Buffer.from(`fake tarball bytes for orosus 0.2.0 — ${"x".repeat(4096)}`);
const INTEGRITY = `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`;

const setup = (): { configPath: string; tmpDir: string } => {
	dir = mkdtempSync(join(tmpdir(), "orosus-upgrade-"));
	const configPath = join(dir, "config.toml");
	writeFileSync(configPath, 'language = "zh-CN"\n', "utf8"); // 钉语言（HERMETIC + 断言确定性）
	return { configPath, tmpDir: join(dir, "tmp") };
};

const fetchWith = (version: string, opts: { integrity?: string; tarballFail?: boolean } = {}): typeof fetch =>
	(async (url: string | URL): Promise<Response> => {
		if (String(url).includes("/latest")) {
			return new Response(
				JSON.stringify({ version, dist: { tarball: "https://registry.npmjs.org/orosus/-/orosus-0.2.0.tgz", ...(opts.integrity !== undefined ? { integrity: opts.integrity } : {}) } }),
				{ headers: { "content-type": "application/json" } },
			);
		}
		if (opts.tarballFail) return new Response("gone", { status: 404 });
		return new Response(TARBALL, { headers: { "content-length": String(TARBALL.length) } });
	}) as unknown as typeof fetch;

type Over = {
	fetchImpl?: typeof fetch | undefined;
	confirm?: (p: string) => Promise<boolean>;
	install?: UpgradeCmdIo["install"];
	isTTY?: boolean;
	currentVersion?: string;
	progress?: (s: string) => void;
};

const run = async (argv: string[], over: Over = {}): Promise<{ code: number; lines: string[] }> => {
	const { configPath, tmpDir } = setup();
	const lines: string[] = [];
	const code = await runUpgradeSubcommand(argv, {
		out: (l) => lines.push(l),
		configPath,
		tmpDir,
		fetchImpl: over.fetchImpl,
		...(over.confirm !== undefined ? { confirm: over.confirm } : {}),
		...(over.install !== undefined ? { install: over.install } : {}),
		...(over.isTTY !== undefined ? { isTTY: over.isTTY } : {}),
		...(over.currentVersion !== undefined ? { currentVersion: over.currentVersion } : {}),
		...(over.progress !== undefined ? { progress: over.progress } : {}),
	});
	return { code, lines };
};

describe("isUpgradeSubcommand / renderProgress / detectPackageManager", () => {
	it("argv[0] 精确匹配", () => {
		expect(isUpgradeSubcommand(["upgrade"])).toBe(true);
		expect(isUpgradeSubcommand(["upgrade", "--x"])).toBe(true);
		expect(isUpgradeSubcommand(["--print", "upgrade"])).toBe(false);
		expect(isUpgradeSubcommand([])).toBe(false);
	});
	it("进度条：百分比 + 无总长形态 + 满格钳制", () => {
		expect(renderProgress(50, 100)).toContain("50%");
		expect(renderProgress(0, 100)).toContain("0%");
		expect(renderProgress(120, 100)).toContain("100%"); // 钳制（content-length 虚报不越界）
		expect(renderProgress(512, undefined)).toContain("downloading");
	});
	it("pnpm 推断：resolve 不到 → npm 兜底", () => {
		expect(detectPackageManager()).toBe("npm"); // dev 仓内 resolve "orosus/package.json" 不中
	});
});

describe("runUpgradeSubcommand 分支", () => {
	it("多余参数 → 退出码 2 + 用法", async () => {
		const r = await run(["upgrade", "--force"]);
		expect(r.code).toBe(2);
		expect(r.lines[0]).toContain("未知参数");
	});

	it("dev 形态（0.0.0-dev）→ git pull 指引、不取数", async () => {
		let called = 0;
		const r = await run(["upgrade"], {
			currentVersion: "0.0.0-dev",
			fetchImpl: (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch,
		});
		expect(r.code).toBe(0);
		expect(r.lines[0]).toContain("git pull");
		expect(called).toBe(0);
	});

	it("检查失败 → 退出码 1 + 人话 err", async () => {
		const r = await run(["upgrade"], { currentVersion: "0.1.0", fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
		expect(r.code).toBe(1);
		expect(r.lines[0]).toContain("检查更新失败");
		expect(r.lines[0]).toContain("offline");
	});

	it("已最新 → 退出码 0", async () => {
		const r = await run(["upgrade"], { currentVersion: "0.1.0", fetchImpl: fetchWith("0.1.0") });
		expect(r.code).toBe(0);
		expect(r.lines[0]).toContain("已是最新版本 0.1.0");
	});

	it("非 TTY：不交互不安装，打印升级命令退出 0", async () => {
		let confirmCalled = 0;
		let installCalled = 0;
		const r = await run(["upgrade"], {
			currentVersion: "0.1.0",
			fetchImpl: fetchWith("0.2.0", { integrity: INTEGRITY }),
			isTTY: false,
			confirm: async () => { confirmCalled++; return true; },
			install: async () => { installCalled++; return { code: 0, output: "" }; },
		});
		expect(r.code).toBe(0);
		expect(r.lines[0]).toContain("npm install -g orosus@0.2.0");
		expect(confirmCalled).toBe(0);
		expect(installCalled).toBe(0);
	});

	it("确认拒绝 → 已取消、不下载不安装", async () => {
		let installCalled = 0;
		const r = await run(["upgrade"], {
			currentVersion: "0.1.0",
			fetchImpl: fetchWith("0.2.0", { integrity: INTEGRITY }),
			isTTY: true,
			confirm: async () => false,
			install: async () => { installCalled++; return { code: 0, output: "" }; },
		});
		expect(r.code).toBe(0);
		expect(r.lines[0]).toContain("已取消");
		expect(installCalled).toBe(0);
	});

	it("下载失败（tarball 404）→ 退出码 1", async () => {
		const r = await run(["upgrade"], {
			currentVersion: "0.1.0",
			fetchImpl: fetchWith("0.2.0", { tarballFail: true }),
			isTTY: true,
			confirm: async () => true,
			progress: () => {},
		});
		expect(r.code).toBe(1);
		expect(r.lines[0]).toContain("下载失败");
	});

	it("integrity 不匹配 → 放弃安装、不 spawn", async () => {
		let installCalled = 0;
		const r = await run(["upgrade"], {
			currentVersion: "0.1.0",
			fetchImpl: fetchWith("0.2.0", { integrity: "sha512-Zm9vYmFy" }),
			isTTY: true,
			confirm: async () => true,
			progress: () => {},
			install: async () => { installCalled++; return { code: 0, output: "" }; },
		});
		expect(r.code).toBe(1);
		expect(r.lines[0]).toContain("校验失败");
		expect(installCalled).toBe(0);
	});

	it("安装失败含 EBUSY → 失败行 + 占用提示", async () => {
		const r = await run(["upgrade"], {
			currentVersion: "0.1.0",
			fetchImpl: fetchWith("0.2.0", { integrity: INTEGRITY }),
			isTTY: true,
			confirm: async () => true,
			progress: () => {},
			install: async () => ({ code: 1, output: "npm ERR! code EBUSY\nnpm ERR! operation not permitted" }),
		});
		expect(r.code).toBe(1);
		expect(r.lines.some((l) => l.includes("安装失败"))).toBe(true);
		expect(r.lines.some((l) => l.includes("实例"))).toBe(true); // busyHint
	});

	it("安装失败无 EBUSY → 不附占用提示", async () => {
		const r = await run(["upgrade"], {
			currentVersion: "0.1.0",
			fetchImpl: fetchWith("0.2.0", { integrity: INTEGRITY }),
			isTTY: true,
			confirm: async () => true,
			progress: () => {},
			install: async () => ({ code: 1, output: "some other failure" }),
		});
		expect(r.code).toBe(1);
		expect(r.lines.some((l) => l.includes("实例"))).toBe(false);
	});

	it("成功链：下载（100% 帧）→ 落 tmp tgz → npm install → 完成感谢 + tmp 清理", async () => {
		let sawTgz = false;
		let installMeta: { latest: string; manager: "npm" | "pnpm" } | undefined;
		let tgzPath = "";
		const frames: string[] = [];
		const r = await run(["upgrade"], {
			currentVersion: "0.1.0",
			fetchImpl: fetchWith("0.2.0", { integrity: INTEGRITY }),
			isTTY: true,
			confirm: async () => true,
			progress: (s) => frames.push(s),
			install: async (tgz, meta) => {
				tgzPath = tgz;
				sawTgz = existsSync(tgz);
				installMeta = meta;
				return { code: 0, output: "added 1 package in 2s" };
			},
		});
		expect(r.code).toBe(0);
		expect(frames.some((f) => f.includes("100%"))).toBe(true); // 真进度条走到头
		expect(sawTgz).toBe(true); // 安装期 tgz 已落盘
		expect(installMeta).toEqual({ latest: "0.2.0", manager: "npm" });
		expect(existsSync(tgzPath)).toBe(false); // 完成后临时件已清
		expect(r.lines.some((l) => l.includes("正在安装"))).toBe(true);
		const done = r.lines.find((l) => l.includes("0.2.0"));
		expect(done).toBeTruthy();
		expect(done).toContain("感谢");
	});
});
