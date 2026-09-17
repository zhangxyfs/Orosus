import { createInterface } from "node:readline/promises";
import { createHarness } from "@orosus/core";
import type { Chunk } from "@orosus/contracts/provider";
import { BUILTIN_MODULES } from "./builtins.ts";
import { createReadlineUi } from "./menu.ts";
import { parseArgs } from "./args.ts";

const args = parseArgs(process.argv.slice(2));

// rl 与交互 UI（D35，T10）：先于 harness 创建——/model、/provider 等菜单命令经 commandUi 注入。
// M3 口子：审批模块的 waterfall 询问流将复用同一 UI 注入路径（届时经 ctx 扩展，形态随 M3 方案审查定）。
const rl = createInterface({ input: process.stdin, output: process.stdout });
// 行队列：readline 的 question() 会丢弃两次询问之间到达的行（管道喂多条命令丢行），
// 且 EOF 落在 await 间隙时已关闭接口上的 question 永不 settle（退出码 13 挂起）——REPL 一律走队列兜底。
const pendingLines: string[] = [];
let lineWake: (() => void) | undefined;
let stdinClosed = false;
let askActive = false; // 菜单询问期间的行归询问消费（REPL 不抢答）
rl.on("line", (l) => {
  if (askActive) return;
  pendingLines.push(l);
  const w = lineWake;
  lineWake = undefined;
  w?.();
});
rl.once("close", () => {
  stdinClosed = true;
  const w = lineWake;
  lineWake = undefined;
  w?.();
});
const nextLine = async (): Promise<string | null> => {
  for (;;) {
    const l = pendingLines.shift();
    if (l !== undefined) return l;
    if (stdinClosed) return null;
    await new Promise<void>((r) => { lineWake = r; });
  }
};
const commandUi = createReadlineUi({
  question: async (q) => {
    askActive = true;
    try {
      return await rl.question(q);
    } finally {
      askActive = false;
    }
  },
});

const h = await createHarness({
  builtinModules: BUILTIN_MODULES,
  commandUi,
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

try {
  for (;;) {
    process.stdout.write("> ");
    const line = await nextLine(); // EOF（管道耗尽 / Ctrl-D）→ null → 退出
    if (line === null) break;
    const text = line.trim();
    if (text === "/quit") break;
    if (text === "") continue;
    try {
      // 命令输入时 harness.prompt 返回命令输出（D38）——必须回显（M2 补账：原实现从不打印，命令「敲了没反应」）
      const out = await h.prompt(text);
      if (out !== undefined) console.log(out);
    } catch (err) {
      console.error(`[错误] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
} finally {
  rl.close();
  await h.close();
  await render;
}
