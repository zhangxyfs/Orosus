import { describe, it, expect } from "vitest";
import { confirmDialogWidgets, declarationWidgets, type PendingModuleInfo } from "./module-confirm.ts";

/** m5 T17：首挂确认弹窗声明面——人话清单、空项隐藏、hash-changed 警示行、不列 contributes。 */

const base: PendingModuleInfo = {
  name: "note",
  version: "0.1.0",
  layer: "user",
  root: "C:/Users/x/.orosus/modules/note",
  reason: "unconfirmed（用户级模块首次挂载待确认）",
  def: {},
};

describe("首挂确认弹窗内容（m5 T17）", () => {
	it("① 声明面：provides/dependsOn/mounts/uses 逐位人话清单；空项不显示", () => {
		const w = declarationWidgets({ ...base, def: { provides: ["note.store"], dependsOn: ["fs", { capability: "web.search", optional: true } as { capability: string; optional?: boolean }], mounts: ["settings"], uses: ["config.foreign"] } });
		const text = JSON.stringify(w);
		expect(text).toContain("note.store");
		expect(text).toContain("fs、web.search（可选）"); // 可选依赖的人话形
		expect(text).toContain("settings");
		expect(text).toContain("config.foreign");
		const bare = declarationWidgets({ ...base, def: {} });
		const bareText = JSON.stringify(bare);
		expect(bareText).not.toContain("提供"); // 空项隐藏——kv 行整行不出现
		expect(bareText).not.toContain("依赖");
	});

	it("② hash-changed（项目级代码变更）→ 顶部警示行；固定诚实行两句恒在", () => {
		const changed = declarationWidgets({ ...base, layer: "project", reason: "untrusted（项目级模块代码已变更，须重新确认，§8.5/MCPoison）" });
		expect(JSON.stringify(changed)).toContain("代码已变更");
		const w = declarationWidgets(base);
		const text = JSON.stringify(w);
		expect(text).toContain("确认前看不到"); // 诚实行 1：注册物激活时才注册
		expect(text).toContain("信得过的来源"); // 诚实行 2：契约外能力
	});

	it("③ 完整弹窗带操作列表（确认开启/取消）；不列 contributes（未确认模块拿不到——列了是撒谎）", () => {
		const w = confirmDialogWidgets(base);
		const text = JSON.stringify(w);
		expect(text).toContain("确认开启");
		expect(text).toContain("取消");
		expect(text).not.toContain("contributes");
	});
});
