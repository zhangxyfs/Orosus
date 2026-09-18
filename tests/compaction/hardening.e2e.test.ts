import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore, type SessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { defineTool } from "@orosus/contracts/tool";
import { z } from "zod";
import type { Chunk } from "@orosus/contracts/provider";
import type { ModuleDefinition } from "@orosus/contracts/module";
import compaction from "@orosus/compaction";
import { attachRender, renderEvent } from "../../apps/cli/src/render.ts";

/** M3 补强 T8：强化端到端——prune 全链 / 溢出恢复全链（loop×compaction×锚点装配）/ 溢出两连败 / CLI 渲染两分支。 */
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = async (opts: { script: Chunk[][]; configToml: string; withTool?: boolean; render?: { buf: string[] } }) => {
  dir = mkdtempSync(join(tmpdir(), "orosus-hardening-"));
  writeFileSync(join(dir, "config.toml"), opts.configToml, "utf8");
  const store: SessionStore = new InMemorySessionStore();
  const fp = fakeProvider(opts.script);
  const modules: ModuleDefinition[] = [{
    name: "provider-fake", version: "0.1.0", description: "f", api: 1,
    activate: (ctx) => { ctx.provide("provider:fake" as never, fp.stream); },
  }];
  if (opts.withTool === true) {
    modules.push({
      name: "mod", version: "0.1.0", description: "t", api: 1,
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "mod__big", description: "大输出", parameters: z.object({}),
          resolveExecution: async () => ({ execute: async () => ({ output: "y".repeat(20_000), isError: false }) }),
        }));
      },
    });
  }
  const h = await createHarness({
    cwd: dir,
    store,
    diagDir: dir,
    spillDir: join(dir, "spill"),
    modules,
    builtinModules: [compaction],
    secretsFile: join(dir, "s.env"),
    discovery: { userDir: join(dir, "m"), projectDir: join(dir, "p"), trustFile: join(dir, "t.json") },
    config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
  });
  if (opts.render !== undefined) attachRender(h, (s) => void opts.render!.buf.push(s));
  return { h, fp, store };
};

describe("compaction 强化端到端（M3 补强 T8/D44）", () => {
  it("① prune 全链：超大工具输出 → 阈值触发 → 落 turn/prune（免摘要）→ 后续请求收到裁剪投影（标记在位）", async () => {
    const { h, fp, store } = await mk({
      configToml: "[compaction]\nthresholdTokens = 5000\n",
      withTool: true,
      script: [
        [{ type: "toolcall/argumentsDelta", callId: "c1", name: "mod__big", argumentsDelta: "{}" }, { type: "finish", kind: "toolUse" }] as Chunk[],
        [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }] as Chunk[],
      ],
    });
    await h.prompt("读");
    const second = fp.requests[1]!;
    const pruned = second.messages.find((m) => m.role === "toolResult") as { output: string } | undefined;
    expect(pruned).toBeDefined();
    expect(pruned!.output).toContain("[...pruned: original 20000 chars...]");
    const all = await store.all();
    expect(all.some((e) => e.type === "turn/prune")).toBe(true);
    expect(all.some((e) => e.type === "turn/compaction")).toBe(false); // 免摘要救援：低于阈值后不再调 llm
    await h.close();
  });

  it("② 溢出恢复全链：首请求 context_limit → 自动压缩（events 含 turn/compaction）→ 重试成功、turn completed", async () => {
    const { h, fp, store } = await mk({
      configToml: "[compaction]\nthresholdTokens = 60000\n", // 常规永不触发——只有溢出 force 会压
      script: [
        [{ type: "text/delta", text: "turn1" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "finish", kind: "error", errorMessage: "HTTP 400：This model's maximum context length is 65536 tokens", errorCode: "context_limit" }] as Chunk[],
        [{ type: "text/delta", text: "摘要产物" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "text/delta", text: "turn2" }, { type: "finish", kind: "stop" }] as Chunk[],
      ],
    });
    await h.prompt("一");
    await h.prompt("二");
    const all = await store.all();
    expect(all.some((e) => e.type === "turn/compaction" && e.droppedCount === 2)).toBe(true);
    expect((all.at(-1) as { kind?: string }).kind).toBe("completed");
    expect(fp.requests).toHaveLength(4); // turn1 / 报错请求 / 摘要 / 重试
    const retry = fp.requests[3]!;
    expect(String((retry.messages[0] as { content: { text: string }[] }).content[0]!.text)).toContain("[历史摘要]");
    await h.close();
  });

  it("③ 溢出两连败：turn error 且 errorMessage 含指引文案；provider 恰 4 次（turn1/报错/摘要尝试亦失败/重试报错——失败 turn 的主循环恰 2 次）", async () => {
    const { h, fp, store } = await mk({
      configToml: "[compaction]\nthresholdTokens = 60000\n",
      script: [
        [{ type: "text/delta", text: "turn1" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "finish", kind: "error", errorMessage: "HTTP 400：context_length_exceeded", errorCode: "context_limit" }] as Chunk[],
      ],
    });
    await h.prompt("一");
    await h.prompt("二");
    const end = (await store.all()).at(-1) as { type: string; kind?: string; errorMessage?: string };
    expect(end).toMatchObject({ type: "turn/end", kind: "error" });
    expect(end.errorMessage).toContain("已自动压缩重试仍超限");
    expect(end.errorMessage).toContain("/compact");
    expect(fp.requests).toHaveLength(4); // turn1 / 报错请求 / 摘要尝试（亦失败）→ 重试报错终局——失败 turn 的主循环恰 2 次
    await h.close();
  });

  it("④ CLI 渲染（装配层）：turn/compaction 事件 → 「已压缩：前 N 条」行（N = droppedCount）", async () => {
    const render = { buf: [] as string[] };
    const { h } = await mk({
      configToml: "[compaction]\nthresholdTokens = 60000\n",
      render,
      script: [
        [{ type: "text/delta", text: "turn1" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "finish", kind: "error", errorMessage: "HTTP 400：maximum context length", errorCode: "context_limit" }] as Chunk[],
        [{ type: "text/delta", text: "摘要产物" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "text/delta", text: "turn2" }, { type: "finish", kind: "stop" }] as Chunk[],
      ],
    });
    await h.prompt("一");
    await h.prompt("二");
    expect(render.buf.join("")).toContain("[已压缩：前 2 条历史已摘要，完整原文在会话文件中]");
    await h.close();
  });

  it("⑤ CLI 渲染（装配层）：turn/prune 事件 → 「已裁剪 K 个超长工具结果」行", async () => {
    const render = { buf: [] as string[] };
    const { h } = await mk({
      configToml: "[compaction]\nthresholdTokens = 5000\n",
      withTool: true,
      render,
      script: [
        [{ type: "toolcall/argumentsDelta", callId: "c1", name: "mod__big", argumentsDelta: "{}" }, { type: "finish", kind: "toolUse" }] as Chunk[],
        [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }] as Chunk[],
      ],
    });
    await h.prompt("读");
    expect(render.buf.join("")).toContain("[已裁剪 1 个超长工具结果（原文保留在会话文件中）]");
    await h.close();
  });
});

describe("render 401/403 提示（模型发现 T5——走查缺陷③提示面）", () => {
  it("errorMessage 含 HTTP 401 → 输出含 env 覆盖提示行；500 不含", () => {
    expect(renderEvent({ type: "assistant/chunk", chunk: { type: "finish", kind: "error", errorMessage: "HTTP 401：token expired" } } as never))
      .toContain("检查同名环境变量是否覆盖");
    expect(renderEvent({ type: "assistant/chunk", chunk: { type: "finish", kind: "error", errorMessage: "HTTP 500：boom" } } as never))
      .not.toContain("检查同名环境变量是否覆盖");
  });
});
