import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, policyOf, MEDIA_POLICY_KEY, persistVisionModel, readVisionModel, type MediaPolicyFacts } from "./index.ts";
import { defineModule, MODULE_API_VERSION } from "@orosus/contracts/module";
const probeModApi = MODULE_API_VERSION;
import toolMedia from "./index.ts";
import { createHarness } from "@orosus/core";

let dir: string;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

const MB = 1024 * 1024;

describe("tool-media 配置与策略（m5-media F9——[tool-media] 节，帽值/压缩口径配置源）", () => {
  it("① 缺省值 = 方案定案（D2/D3/D4：4.5MB 单图 / 20MB 总帽 / 10MB 安全线 / 4 张 / 2048px / 2048 档 / visionModel off）", () => {
    const facts = policyOf(configSchema.parse({}));
    expect(facts).toEqual({
      maxEdge: 2048,
      tokenTier: 2048,
      singleCapBytes: 4.5 * MB,
      budgetBytes: 20 * MB,
      safeBytes: 10 * MB,
      maxImages: 4,
      visionModel: "off",
    } satisfies MediaPolicyFacts);
  });

  it("② 用户收紧全链生效（重度走查场景：1024 档 / 512px / 2 张 / 8MB 帽）", () => {
    const facts = policyOf(configSchema.parse({ maxEdge: 512, tokenTier: 1024, maxImages: 2, budgetMb: 8, safeMb: 4, singleCapMb: 2 }));
    expect(facts.maxEdge).toBe(512);
    expect(facts.tokenTier).toBe(1024);
    expect(facts.maxImages).toBe(2);
    expect(facts.budgetBytes).toBe(8 * MB);
    expect(facts.safeBytes).toBe(4 * MB);
    expect(facts.singleCapBytes).toBe(2 * MB);
  });

  it("③ 服务键带模块名前缀（圈地纪律：tool-media.policy——违规裸名会静默降级）", () => {
    expect(MEDIA_POLICY_KEY).toBe("tool-media.policy");
  });

  it("④ 模块激活冒烟：随 harness 装载零降级，policy 服务可取（服务倒挂消费面成立）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-tm-"));
    let face: { current(): MediaPolicyFacts } | undefined;
    // 探针模块：真 provider 槽 + **调用期惰性**取 policy 服务（activate 期 committedServices 未提交——
    // 圈地纪律铁律，provider-custom 真实消费同款形态：首个请求里 getOptional）
    const probeMod = defineModule({
      name: "provider-probe", version: "0.1.0", description: "probe", api: probeModApi,
      mounts: ["provide"],
      activate(ctx) {
        ctx.provide("provider:probe" as never, () => (async function* () {
          const f = await ctx.services.getOptional<{ current(): MediaPolicyFacts }>(MEDIA_POLICY_KEY as never);
          face = f ?? undefined;
          yield { type: "text/delta" as const, text: "ok" };
          yield { type: "finish" as const, kind: "stop" as const };
        })());
      },
    });
    const h = await createHarness({
      diagDir: dir,
      spillDir: join(dir, "spill"),
      sessionsDir: join(dir, "sessions"),
      modules: [toolMedia as never, probeMod as never],
      config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "n2.toml"), env: {}, cliOverrides: { model: "probe/m" } },
    });
    try {
      await h.prompt("嗨");
      await new Promise((r) => setTimeout(r, 50)); // 探针异步解析完成
      expect(face).toBeDefined();
      expect(face!.current().maxEdge).toBe(2048); // 缺省策略经服务面到达
    } finally {
      await h.close();
    }
  }, 30_000);
});

// F14 落盘件往返（persist.ts——settings/引导两入口共用写器）
describe("persistVisionModel / readVisionModel（F14）", () => {
  it("缺省 off；写 auto / 指定槽全名往返保真；与其他 [tool-media] 键共存", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-vp-"));
    const f = join(dir, "tool-media.toml");
    expect(readVisionModel(f)).toBe("off"); // 无文件缺省
    persistVisionModel(f, "auto");
    persistVisionModel(f, "zhipuai-coding-plan/glm-5.3-flash");
    expect(readVisionModel(f)).toBe("zhipuai-coding-plan/glm-5.3-flash");
    // 再写回 off（三态切换不残留）
    persistVisionModel(f, "off");
    expect(readVisionModel(f)).toBe("off");
  });
});
