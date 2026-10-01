// m5-media T5 e2e：MCP fixture 图块 → core 归一化落盘媒资库 → 假 provider 收到 toolResult.parts（路径引用）
// → openai 线缆（bridge）翻译带 image_url。全链四层各断言一层；装配面（harness mediaDir 注入）被拿掉即红。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, JsonlSessionStore, type SessionEvent } from "@orosus/core";
import { mcpDef } from "@orosus/mcp";
import { toOpenAIMessages } from "../packages/modules/provider-custom/src/translate-openai.ts";
import type { Chunk, ProviderRequest } from "@orosus/contracts/provider";
import { defineModule } from "@orosus/contracts/module";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("m5-media T5：MCP 图块全链（fixture server → 媒资库 → ModelMessage.parts → openai 线缆）", () => {
  it("image 工具 → <sid>/media/ 落盘 + 第二请求 toolResult.parts（路径引用）+ bridge 翻译出 image_url user 消息", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-m5e2e-"));
    const sessionsDir = join(dir, "sessions");
    const requests: ProviderRequest[] = [];
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "mcp__fx__image", argumentsDelta: "{}" },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "看到了红色" }, { type: "finish", kind: "stop" }],
    ];
    let i = 0;
    const provider = defineModule({
      name: "provider-fake", version: "0.1.0", description: "fake", api: 1,
      activate(ctx) {
        ctx.provide("provider:fake" as never, (req: import("@orosus/contracts/provider").ProviderRequest) => {
          requests.push(req);
          const chunks = script[Math.min(i++, script.length - 1)]!;
          return (async function* () { for (const c of chunks) yield c; })();
        });
      },
    });
    writeFileSync(
      join(dir, "config.toml"),
      ["[mcp.servers.fx]", `command = "node"`, `args = ['${FIXTURE.replace(/\\/g, "/")}']`, ""].join("\n"),
      "utf8",
    );
    const h = await createHarness({
      diagDir: dir,
      spillDir: join(dir, "spill"),
      sessionsDir,
      modules: [mcpDef as never, provider as never],
      config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "none.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    const drain = (async () => { for await (const _e of h.events()) void _e; })();
    try {
      await h.prompt("截图看看");
      await h.close();
      await drain;

      // ① 会话日志：tool/result 带 images（路径引用——不是 base64）
      const all: SessionEvent[] = await new JsonlSessionStore({ dir: sessionsDir, sessionId: h.sessionId }).all();
      const result = all.find((e) => e.type === "tool/result");
      expect(result).toBeDefined();
      const images = result!.images as { path: string; mimeType: string }[];
      expect(Array.isArray(images)).toBe(true);
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ mimeType: "image/png" });

      // ② 媒资库：文件真实落盘（<sid>/media/，内容 = PNG 字节）——harness mediaDir 注入装配钉
      expect(images[0]!.path).toMatch(/[\\/]media[\\/]media-\d+-c1\.png$/);
      const bytes = readFileSync(images[0]!.path);
      expect(bytes.length).toBeGreaterThan(50); // 真 1x1 PNG，非空壳
      expect(bytes[0]).toBe(0x89); // PNG 魔数

      // ③ 第二请求（假 provider 收到的 ModelMessage）：toolResult.parts 引用同一路径
      const tr = requests[1]!.messages.find((m) => m.role === "toolResult");
      if (tr === undefined || tr.role !== "toolResult") throw new Error("第二请求缺 toolResult 消息");
      expect(tr.parts?.[0]).toMatchObject({ kind: "image", path: images[0]!.path, mimeType: "image/png" });

      // ④ openai 线缆（bridge 默认）：tool 消息纯文本 + 紧跟只含 image_url 的 user 消息（T0 spike C 形态）
      const wire = toOpenAIMessages("", requests[1]!.messages) as Array<{ role: string; content: unknown }>;
      const toolMsg = wire.find((m) => m.role === "tool");
      expect(typeof toolMsg!.content).toBe("string"); // bridge：tool 消息不吃图
      const flushMsg = wire.find((m) => m.role === "user" && Array.isArray(m.content));
      expect(flushMsg).toBeDefined();
      const flushParts = flushMsg!.content as Array<{ type: string; image_url?: { url: string } }>;
      expect(flushParts.some((p) => p.type === "image_url" && p.image_url!.url.startsWith("data:image/png;base64,"))).toBe(true);
    } finally {
      await h.close().catch(() => undefined);
    }
  }, 45_000);
});
