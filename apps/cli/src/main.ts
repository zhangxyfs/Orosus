import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHarness, discoverModules } from "@orosus/core";
import type { Harness } from "@orosus/core";
import { BUILTIN_MODULES } from "./builtins.ts";
import { createReadlineUi, createSilenceableOutput } from "./menu.ts";
import { formatSessions, harnessOptionsFor, sessionCommand } from "./sessions.ts";
import { parseArgs } from "./args.ts";
import { isProviderSubcommand, runProviderSubcommand } from "./provider-cmd.ts";
import { isModuleSubcommand, runModuleSubcommand } from "./module-cmd.ts";
import { attachRender as attachRenderTo } from "./render.ts";
import { banner } from "./banner.ts";
import { realReadModel, startupGate } from "./startup.ts";

// 子命令拦截（M2 接口总表：互斥于 flag 之外先解析）——M2 补账：T8/T13 处理器此前从未接线，
// `orosus provider ...` / `orosus module ...` 会被 flag 解析器当未知参数拒收
{
  const argv = process.argv.slice(2);
  const orosusHome = join(homedir(), ".orosus");
  if (isProviderSubcommand(argv)) {
    process.exit(await runProviderSubcommand(argv, {
      configPath: join(orosusHome, "config.toml"),
      secretsPath: join(orosusHome, "secrets.env"),
      env: process.env,
      out: (l) => console.log(l),
    }));
  }
  if (isModuleSubcommand(argv)) {
    const discovered = await discoverModules({
      userDir: join(orosusHome, "modules"),
      projectDir: join(process.cwd(), ".orosus", "modules"),
      userFile: join(orosusHome, "config.toml"),
      sink: { write: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() },
    });
    process.exit(await runModuleSubcommand(argv, {
      configPath: join(orosusHome, "config.toml"),
      trustFile: join(orosusHome, "trust.json"),
      discovered: discovered.map((m) => ({ name: m.def.name, root: m.root, entryHash: m.entryHash, layer: m.layer })),
      out: (l) => console.log(l),
    }));
  }
}

const args = parseArgs(process.argv.slice(2));
const sessionsDir = join(homedir(), ".orosus", "sessions");

// rl 与交互 UI（D35，T10）：先于 harness 创建——/model、/provider 等菜单命令经 commandUi 注入。
// M3 口子：审批模块的 waterfall 询问流将复用同一 UI 注入路径（届时经 ctx 扩展，形态随 M3 方案审查定）。
// 输出走可静默代理：密钥询问期间 rl 回显全吞（盲输，ssh/docker 同款）——逐键 * 回显在真实 Windows
// 终端层会碎成孤星（走查实录），静默在任意终端层行为一致。terminal/列宽透传给代理保住行编辑。
const stdoutEcho = createSilenceableOutput(process.stdout);
if (process.stdout.isTTY === true) {
  Object.defineProperty(stdoutEcho, "isTTY", { value: true });
  Object.defineProperty(stdoutEcho, "columns", { get: () => process.stdout.columns });
}
const rl = createInterface({ input: process.stdin, output: stdoutEcho });
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
      // 命令开始前已到的行（管道脚本/用户预打字）优先喂给询问——否则队列与 question 各等各的（脑裂挂起）
      const queued = pendingLines.shift();
      if (queued !== undefined) return queued;
      // EOF 竞速：stdin 关闭后（或期间）的询问以拒绝收场——命令带内失败（D35 fail-closed 语义）。
      // 监听逐次挂摘（不用 standing promise）：正常退出时 rl.close() 不产生无人消费的 rejection
      return await new Promise<string>((resolve, reject) => {
        const onClose = (): void => reject(new Error("无交互环境（stdin 已关闭）——交互式命令不可用（D35 fail-closed）"));
        rl.once("close", onClose);
        rl.question(q).then(
          (v) => { rl.removeListener("close", onClose); resolve(v); },
          (e) => { rl.removeListener("close", onClose); reject(e); },
        );
      });
    } finally {
      askActive = false;
    }
  },
  // 密钥询问（静默盲输）：提示语写真 stdout（明示不回显），rl 回显经代理全吞——
  // 结束后补换行（回车回显也被吞了）。管道预输行直接采纳——非 TTY 无回显，天然不泄漏
  secretQuestion: async (q) => {
    askActive = true;
    try {
      const queued = pendingLines.shift();
      if (queued !== undefined) return queued;
      process.stdout.write(`${q}（输入不回显）: `);
      stdoutEcho.silence(true);
      try {
        return await new Promise<string>((resolve, reject) => {
          const onClose = (): void => reject(new Error("无交互环境（stdin 已关闭）——交互式命令不可用（D35 fail-closed）"));
          rl.once("close", onClose);
          rl.question("").then(
            (v) => { rl.removeListener("close", onClose); resolve(v); },
            (e) => { rl.removeListener("close", onClose); reject(e); },
          );
        });
      } finally {
        stdoutEcho.silence(false);
        process.stdout.write("\n");
      }
    } finally {
      askActive = false;
    }
  },
});

const createSession = (extra: { fork?: { parentSessionId: string; atEntryId?: string } } = {}) =>
  createHarness({
    builtinModules: BUILTIN_MODULES,
    commandUi,
    sessionsDir,
    ...(args.resume !== undefined ? { resume: args.resume } : {}),
    ...(extra.fork !== undefined ? { fork: extra.fork } : {}),
    config: {
      enableModules: args.enable,
      disableModules: args.disable,
      noModules: args.noModules,
      module: args.module,
      ...(args.model !== undefined ? { cliOverrides: { model: args.model } } : {}),
    },
  });

let h = await createSession();

// 启动审计横幅在 sessionLoop 首轮统一打印（banner.ts 可测抽取；分级规则见彼处注释——B7 提前落地）

if (args.dumpModules) {
  console.log(h.graph().catalog());
  await h.close();
  process.exit(0);
}

// 首启引导（模型发现 T0——M3 T9 欠账接线）：TTY 且需要配置 → 确认转 /provider 向导 → /reload → 复检回显；
// 非交互跳过；只挂首会话（/new、/fork 换出的会话不再触发，M3 T9 定案）
if (process.stdin.isTTY) {
  const out = await startupGate({ h, ui: commandUi, readModel: realReadModel(process.cwd()), isTty: true });
  if (out !== undefined) console.log(out);
}

// 事件渲染：会话日志的实时投影（append 即转发，§6.7）；lastEventId 供 /fork 选分叉点
// 渲染面抽至 render.ts（M3 补强 T8：压缩/裁剪可见性 + 可测性注入）
let lastEventId: string | undefined;
function attachRender(h: Harness): void {
  attachRenderTo(h, (s) => process.stdout.write(s), (id) => { lastEventId = id; });
}

process.on("SIGINT", () => h.cancel()); // Ctrl-C 中止当前 turn，不退出（h 为当前会话）

try {
  sessionLoop: for (;;) {
    for (const line of banner(h)) console.error(line);
    attachRender(h);
    for (;;) {
      process.stdout.write("> ");
      const line = await nextLine(); // EOF（管道耗尽 / Ctrl-D）→ null → 退出
      if (line === null) break sessionLoop;
      const text = line.trim();
      if (text === "") continue;
      // CLI 拦截层（D38 第一层）：会话生命周期命令（/new /fork /sessions，D41/T6）
      if (text === "/sessions") {
        console.log(formatSessions(sessionsDir));
        continue;
      }
      const directive = sessionCommand(text, { sessionId: h.sessionId, lastEventId });
      if (directive.kind === "quit") break sessionLoop; // /quit 同义 /exit /q（用户要求 2026-09-18）——经 sessionCommand 可测面
      if (directive.kind === "new" || directive.kind === "fork") {
        const from = directive.kind === "fork" ? directive.parentSessionId : undefined;
        await h.close();
        h = await createSession(harnessOptionsFor(directive));
        console.log(from !== undefined ? `[已从 ${from} 分叉——新会话 ${h.sessionId}]` : `[新会话 ${h.sessionId}]`);
        continue sessionLoop; // 重挂横幅与渲染（新事件流）
      }
      try {
        // 命令输入时 harness.prompt 返回命令输出（D38）——必须回显（M2 补账：原实现从不打印，命令「敲了没反应」）
        const out = await h.prompt(text);
        if (out !== undefined) console.log(out);
      } catch (err) {
        console.error(`[错误] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
} finally {
  rl.close();
  await h.close();
}
