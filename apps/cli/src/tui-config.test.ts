import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { tuiSidebarPersist, tuiSidebarRead } from "./tui-config.ts";

/** CM-01 回归钉（2026-09-28 code review P0）：带 BOM / 坏 TOML 的 config.toml 上按 Ctrl+T，
 *  旧实现整盘覆写只剩 [tui] 节静默毁配置——三钉：BOM 剥离往返不丢节、坏盘拒写、读侧 BOM 不再落缺省。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const cfg = (): string => join(dir, "config.toml");

describe("[tui] sidebar 读写（CM-01 修复回归）", () => {
	it("① BOM 盘 persist：剥 BOM 解析成功，其余节原样保留、只改 sidebar", () => {
		dir = mkdtempSync(join(tmpdir(), "tui-cfg-"));
		writeFileSync(cfg(), "\uFEFF[approval]\nmode = \"ask-risky\"\n\n[tui]\nsidebar = false\n", "utf8");
		tuiSidebarPersist(true, cfg());
		const doc = parse(readFileSync(cfg(), "utf8")) as Record<string, unknown>;
		expect(doc.approval).toEqual({ mode: "ask-risky" }); // 旧实现此节已被洗掉
		expect((doc.tui as Record<string, unknown>).sidebar).toBe(true);
	});

	it("② 坏 TOML persist：文件在但解析失败 → 拒写，盘上原样（不覆写成 [tui] 残骸）", () => {
		dir = mkdtempSync(join(tmpdir(), "tui-cfg-"));
		const raw = "this is = = not valid toml ][\n";
		writeFileSync(cfg(), raw, "utf8");
		tuiSidebarPersist(true, cfg());
		expect(readFileSync(cfg(), "utf8")).toBe(raw); // 核心钉：读不懂就不碰
	});

	it("③ 缺文件 persist：从空起建 [tui]，正常生效", () => {
		dir = mkdtempSync(join(tmpdir(), "tui-cfg-"));
		tuiSidebarPersist(false, cfg());
		const doc = parse(readFileSync(cfg(), "utf8")) as Record<string, unknown>;
		expect((doc.tui as Record<string, unknown>).sidebar).toBe(false);
	});

	it("④ read：BOM 盘读到真值（旧实现 parse 必抛 → 落缺省 true）；用户层缺 → 项目层兜底", () => {
		dir = mkdtempSync(join(tmpdir(), "tui-cfg-"));
		const userFile = cfg();
		const projectFile = join(dir, "proj", ".orosus", "config.toml");
		writeFileSync(userFile, "\uFEFF[tui]\nsidebar = false\n", "utf8");
		expect(tuiSidebarRead(userFile, projectFile)).toBe(false); // 旧实现这里返回 true
		rmSync(userFile);
		mkdirSync(join(dir, "proj", ".orosus"), { recursive: true });
		writeFileSync(projectFile, "[tui]\nsidebar = false\n", "utf8");
		expect(tuiSidebarRead(userFile, projectFile)).toBe(false);
		expect(tuiSidebarRead(join(dir, "none.toml"), join(dir, "none2.toml"))).toBe(true); // 双缺 = 缺省可见
	});
});
