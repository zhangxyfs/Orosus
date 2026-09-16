import { createInterface } from "node:readline/promises";
import { createHarness } from "@orosus/core";
import type { Chunk } from "@orosus/contracts/provider";
import toolFs from "@orosus/tool-fs";
import toolShell from "@orosus/tool-shell";
import anthropic from "@orosus/provider-anthropic";
import { parseArgs } from "./args.ts";

const args = parseArgs(process.argv.slice(2));

const h = await createHarness({
  builtinModules: [toolFs, toolShell, anthropic],
  config: {
    enableModules: args.enable,
    disableModules: args.disable,
    noModules: args.noModules,
    module: args.module,
    ...(args.model !== undefined ? { cliOverrides: { model: args.model } } : {}),
  },
});

// 启动审计横幅（§4.2 第 7 步 / §10"降级必须吵闹"三处留痕的 stdout 出口）——--dump-modules 非交互模式除外（v15）
if (!args.dumpModules) {
  const audit = h.graph().audit();
  const failed = audit.filter((a) => a.state === "failed");
  if (failed.length > 0) {
    console.error(`⚠ ${failed.length} 个模块降级（完整表：orosus --dump-modules）：`);
    for (const a of failed) console.error(`  - ${a.name}: ${a.failReason ?? ""}`);
  } else {
    console.error(`[orosus] ${audit.filter((a) => a.state === "active").length} 个模块已激活`);
  }
}

if (args.dumpModules) {
  console.log(h.graph().catalog());
  await h.close();
  process.exit(0);
}

// 事件渲染：会话日志的实时投影（append 即转发，§6.7）
const render = (async () => {
  for await (const e of h.events()) {
    if (e.type === "assistant/chunk") {
      const c = e.chunk as Chunk;
      if (c.type === "text/delta") process.stdout.write(c.text);
      else if (c.type === "finish" && c.kind === "error") process.stdout.write(`\n[模型错误] ${c.errorMessage ?? ""}\n`);
    } else if (e.type === "tool/call") {
      process.stdout.write(`\n[tool] ${String(e.name)} ${JSON.stringify(e.args)}\n`);
    } else if (e.type === "tool/result") {
      process.stdout.write(`[tool ${e.isError === true ? "错误" : "完成"}]\n`);
    } else if (e.type === "turn/end") {
      process.stdout.write("\n");
    }
  }
})();

process.on("SIGINT", () => h.cancel()); // Ctrl-C 中止当前 turn，不退出

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  for (;;) {
    // stdin EOF（管道耗尽 / Ctrl-D）时 question 对已关闭接口 reject → 视作退出
    const line = await rl.question("> ").catch(() => null);
    if (line === null) break;
    const text = line.trim();
    if (text === "/quit") break;
    if (text === "") continue;
    try {
      await h.prompt(text);
    } catch (err) {
      console.error(`[错误] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
} finally {
  rl.close();
  await h.close();
  await render;
}
