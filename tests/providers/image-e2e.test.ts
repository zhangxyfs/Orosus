import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { estimateTokens } from "@orosus/compaction";
import providerCustom from "@orosus/provider-custom";
import type { ModelMessage } from "@orosus/contracts/provider";

/** 图片喂图端到端（M4-2.5 T5）：harness 真链路 → provider-custom（openai 协议族翻译层）→ 线缆 content 数组。
 *  2026-09-23 provider 路线归一（品牌 ×5 退役）：改走 custom 区内厂商——用户真实配置同款形态。 */
describe("图片喂图 e2e（M4-2.5 T5）", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("⑨ prompt 带图 → 经 provider-custom（type=openai）真翻译层后线缆 content 数组含 image_url data URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-t5e2e-")); dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 4]));
    // MP-11 密封：OROSUS_HOME 指向 tmp + 预播种目录盘缓存。此前未密封——effort 解析链（harness 创建期
    // 预热 + 首 turn 解析 → 槽 listThinking → loadCatalog → diskFirstCatalogLoader）读真实 ~/.orosus，
    // 盘缓存缺失即按供给链回落真实网络 GET models.dev：两个无 body GET 抢在 chat POST 前入 bodies，
    // bodies[0].messages 为 undefined 即炸（环境依赖：有盘缓存的机器全过、干净机器必炸）。
    const savedHome = process.env.OROSUS_HOME;
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(join(dir, "cache", "models-dev.json"), JSON.stringify({ fetchedAt: Date.now(), catalog: {} }), "utf8");
    process.env.OROSUS_HOME = dir; // orosusHome() 逐次读 env（无模块级缓存）——createHarness 前设置即全链密封
    writeFileSync(join(dir, "user.toml"), [
      "[provider-custom.providers.test-x]",
      'type = "openai"',
      'baseUrl = "http://127.0.0.1:1/v1"',
      'apiKey = "sk-test"',
      'defaultModel = "k3-test"',
      "",
    ].join("\n"), "utf8");
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const h = await createHarness({
        store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
        builtinModules: [providerCustom],
        config: { env: {}, userFile: join(dir, "user.toml"), projectFile: join(dir, "no2.toml"), cliOverrides: { model: "test-x" } },
      });
      await h.prompt("这张图里有什么", { images: [png] });
      await h.close();
    } finally {
      globalThis.fetch = realFetch;
      if (savedHome === undefined) delete process.env.OROSUS_HOME;
      else process.env.OROSUS_HOME = savedHome;
    }
    // MP-11 钉：密封 + 预播种下零目录网络回落——首个请求即 chat POST、全程无 models.dev / 端点 /models GET
    expect(urls[0]).toBe("http://127.0.0.1:1/v1/chat/completions");
    expect(urls.every((u) => u.endsWith("/chat/completions"))).toBe(true);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const userMsg = (bodies[0] as { messages: Array<{ role: string; content: unknown }> }).messages.find((m) => m.role === "user");
    const content = userMsg!.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[0]!.type).toBe("text");
    expect(parts[1]!.type).toBe("image_url");
    expect(parts[1]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("⑩ estimateTokens 含 image 消息不炸且计粗估值（1000 token/图）", () => {
    const msg: ModelMessage = { role: "user", content: [{ kind: "text", text: "看图" }, { kind: "image", path: "C:/x.png", mimeType: "image/png" }] };
    const withImg = estimateTokens([msg]);
    const textOnly = estimateTokens([{ role: "user", content: [{ kind: "text", text: "看图" }] }]);
    expect(withImg).toBe(textOnly + 1000);
    const imgOnly: ModelMessage = { role: "user", content: [{ kind: "image", path: "C:/y.png", mimeType: "image/jpeg" }] };
    expect(estimateTokens([imgOnly])).toBe(1000);
  });
});
