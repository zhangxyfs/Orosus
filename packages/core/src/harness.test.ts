import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeModule, fakeProviderModule } from "@orosus/testing";
import { InMemorySessionStore } from "./session/memory.ts";
import { createHarness } from "./index.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const script: Chunk[][] = [[{ type: "text/delta", text: "你好" }, { type: "finish", kind: "stop" }]];

// 密封性：userFile/projectFile 显式指向不存在的 tmp 路径，阻断真实 ~/.orosus 与 cwd 配置泄漏进测试；env 传 {} 阻断真实 OROSUS_* 变量；spillDir 同理
const hermetic = (dir: string) => ({
  userFile: join(dir, "no-user.toml"),
  projectFile: join(dir, "no-proj.toml"),
  env: {},
});

const makeHarness = async (extra: Parameters<typeof createHarness>[0] = {}) => {
  dir = mkdtempSync(join(tmpdir(), "orosus-harness-"));
  const base = {
    store: new InMemorySessionStore(),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    modules: [fakeProviderModule("fake", script)],
    config: { ...hermetic(dir), cliOverrides: { model: "fake/m" } },
  };
  return createHarness({ ...base, ...extra, config: { ...base.config, ...(extra.config ?? {}) } });
};

describe("createHarness（§8.1 编程式入口 + §4.2 启动序列）", () => {
  it("prompt 一轮：事件流 = 日志实时投影，session/header 含模块图摘要", async () => {
    const h = await makeHarness();
    const seen: string[] = [];
    let header: { moduleGraph?: { active?: string[] } } | undefined;
    const collect = (async () => {
      for await (const e of h.events()) {
        seen.push(e.type);
        if (e.type === "session/header") header = e as never;
        if (e.type === "turn/end") break;
      }
    })();
    await h.prompt("hi");
    await collect;
    expect(seen).toContain("session/header");
    expect(seen).toContain("user/message");
    expect(seen).toContain("assistant/message");
    expect(seen[seen.length - 1]).toBe("turn/end");
    expect(header!.moduleGraph!.active).toContain("provider-fake");
    await h.close();
  });

  it("未配置 model → prompt 报清晰错误（核心顶层 key，§6.6）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-harness-"));
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      config: hermetic(dir),
      modules: [fakeProviderModule("fake", script)],
    });
    await expect(h.prompt("hi")).rejects.toThrow(/model/);
    await h.close();
  });

  it("model 指向不存在的 provider → 错误列出可用 provider", async () => {
    const h = await makeHarness({ config: { cliOverrides: { model: "ghost/x" } } });
    await expect(h.prompt("hi")).rejects.toThrow(/fake/);
    await h.close();
  });

  it("并发 prompt：第二个立即拒绝（守卫同步占坑，无 TOCTOU 窗口）", async () => {
    const h = await makeHarness();
    const first = h.prompt("hi"); // 不 await——但占坑是同步的，此行返回前 currentTurn 已设
    await expect(h.prompt("again")).rejects.toThrow(/进行中/);
    await first;
    await h.close();
  });

  it("close() 逆序停用模块（dispose 被调用）", async () => {
    let disposed = false;
    const m = fakeModule("m", { activate() { return { dispose() { disposed = true; } }; } });
    const h = await makeHarness({ modules: [fakeProviderModule("fake", script), m] });
    await h.close();
    expect(disposed).toBe(true);
  });

  it("close() 幂等；关闭后 prompt 拒绝（closed 守卫）", async () => {
    const h = await makeHarness();
    await h.close();
    await h.close(); // 幂等不抛
    await expect(h.prompt("hi")).rejects.toThrow(/已关闭/);
  });
});
