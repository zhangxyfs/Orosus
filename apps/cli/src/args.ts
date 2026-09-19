export interface CliArgs {
  enable: string[];
  disable: string[];
  module: string[];        // --module：纯净模式白名单（与 --no-modules 组成纯净模式，§5.4/§8.6）
  noModules: boolean;
  dumpModules: boolean;
  model?: string;
  resume?: { sessionId: string };                         // --resume <id>（D41/T6）
  fork?: { parentSessionId: string; atEntryId?: string }; // --fork <id>[:<entryId>]（D41/T6）
  print?: string;                                          // --print <prompt> / -p（非交互单发，M4-2 T17）
  outputFormat?: "text" | "json" | "stream-json";         // --output-format（仅 --print 模式）
}

const USAGE = `用法: orosus [--model <provider/model>] [--enable-module <name>]...
             [--disable-module <name>]... [--no-modules [--module <name>]...] [--dump-modules]
             [--print <prompt> [--output-format text|json|stream-json]]`;

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
      case "--fork": {
        const v = takeValue(i, "--fork"); i++;
        const [parentSessionId, atEntryId] = v.split(":", 2);
        if (parentSessionId === undefined || parentSessionId === "") throw new Error(`--fork 缺会话 id
${USAGE}`);
        args.fork = { parentSessionId, ...(atEntryId !== undefined && atEntryId !== "" ? { atEntryId } : {}) };
        break;
      }
      default: throw new Error(`未知参数 ${argv[i]}\n${USAGE}`);
    }
  }
  return args;
}
