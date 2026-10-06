export interface CliArgs {
  enable: string[];
  disable: string[];
  module: string[];        // --module：纯净模式白名单（与 --no-modules 组成纯净模式，§5.4/§8.6）
  noModules: boolean;
  dumpModules: boolean;
  model?: string;
  resume?: { sessionId: string };                         // --resume <id>（D41/T6）
  // CL-04（2026-09-28 code review）：--fork 死旗标已移除——解析出的 args.fork 全仓零消费（main.ts 只透传
  // extra.fork = 交互 /fork 指令，启动旗标从未接线 createHarness），留着只会让「--fork 启动分叉」静默失效。
  print?: string;                                          // --print <prompt> / -p（非交互单发，M4-2 T17）
  outputFormat?: "text" | "json" | "stream-json";         // --output-format（仅 --print 模式）
  tui?: "line" | "full";                                   // --tui：界面模式（TUI 批阶段三 F3——full 全屏双栏为 TTY 缺省，line 滚动流降级）
}

const USAGE = `用法: orosus [--model <provider/model>] [--enable-module <name>]...
             [--disable-module <name>]... [--no-modules [--module <name>]...] [--dump-modules]
             [--print <prompt> [--output-format text|json|stream-json]] [--tui line|full]`;

// T1（release-npm）：--version/-v 早退旗标——main 顶部在子命令拦截与 parseArgs 之前消费。
// 精确整串匹配（startsWith 反查误中前缀同款教训——"--version-like" 不算命中）
export function parseEarlyFlags(argv: string[]): { version?: boolean } {
  return argv.includes("--version") || argv.includes("-v") ? { version: true } : {};
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { enable: [], disable: [], module: [], noModules: false, dumpModules: false };
  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺值\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--enable-module": args.enable.push(takeValue(i, "--enable-module")); i++; break;
      case "--disable-module": args.disable.push(takeValue(i, "--disable-module")); i++; break;
      case "--module": args.module.push(takeValue(i, "--module")); i++; break;
      case "--model": args.model = takeValue(i, "--model"); i++; break;
      case "--no-modules": args.noModules = true; break;
      case "--dump-modules": args.dumpModules = true; break;
      case "--print":
      case "-p": {
        const v = takeValue(i, "--print"); i++;
        args.print = v;
        break;
      }
      case "--output-format": {
        const v = takeValue(i, "--output-format"); i++;
        if (v !== "text" && v !== "json" && v !== "stream-json") throw new Error(`--output-format 非法值 "${v}"（合法：text | json | stream-json）\n${USAGE}`);
        args.outputFormat = v;
        break;
      }
      case "--resume": {
        const v = takeValue(i, "--resume"); i++;
        args.resume = { sessionId: v };
        break;
      }
      case "--tui": {
        const v = takeValue(i, "--tui"); i++;
        if (v !== "line" && v !== "full") throw new Error(`--tui 非法值 "${v}"（合法：line | full）
${USAGE}`);
        args.tui = v;
        break;
      }
      default: throw new Error(`未知参数 ${argv[i]}\n${USAGE}`);
    }
  }
  return args;
}
