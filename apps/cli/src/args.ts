export interface CliArgs {
  enable: string[];
  disable: string[];
  module: string[];        // --module：纯净模式白名单（与 --no-modules 组成纯净模式，§5.4/§8.6）
  noModules: boolean;
  dumpModules: boolean;
  model?: string;
}

const USAGE = `用法: orosus [--model <provider/model>] [--enable-module <name>]...
             [--disable-module <name>]... [--no-modules [--module <name>]...] [--dump-modules]`;

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
      default: throw new Error(`未知参数 ${argv[i]}\n${USAGE}`);
    }
  }
  return args;
}
