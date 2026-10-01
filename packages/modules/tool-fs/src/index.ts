import { readFileSync, writeFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { Access, defineTool, type Tool } from "@orosus/contracts/tool";
import { FS, type Fs } from "@orosus/contracts/fs";

/** fs 能力的本地实现（规则 1 提供者）。**读面放开（2026-10-01 批 C 方案一拍板：读任意绝对路径——
 *  对标 ZCode/kimi 等六仓主流「读写分开治理」）；写面仍限根目录内**（越根与符号链接外指照拦）。 */
class LocalFs implements Fs {
  // 显式字段赋值，刻意不用 constructor 参数属性：参数属性是非可擦除语法，node --experimental-strip-types
  // （CLI 的运行方式，Task 21）加载即抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX；vitest 走 esbuild 全转换测不出
  private readonly root: string;

  constructor(root: string) {
    // MB-02（2026-09-28 code review P1）：根先 realpath 归一（根自身经符号链接时比对口径一致）
    this.root = realpathSync(root);
  }

  /** 写面安全检查（方案一保留项）：词法越根 + 符号链接外指双拦——写仍限根内，防用链接绕过写边界。 */
  private safeWrite(path: string): string {
    const abs = resolve(this.root, path);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`路径越出根目录：${path}（写面仍限工作目录内——读面已放开绝对路径，写没有）`);
    }
    // MB-02：词法前缀挡不住工作区内符号链接外指（readFileSync/writeFileSync 跟随链接读写根外文件）——
    // realpath 后复检。新建文件（目标不存在）以最近存在祖先作代表。
    const real = this.realOf(abs);
    if (real !== this.root && !real.startsWith(this.root + sep)) {
      throw new Error(`路径经符号链接越出根目录：${path}`);
    }
    return abs;
  }

  /** realpath 归一——目标不存在（新建文件）时向上取最近存在祖先；到文件系统根仍不存在则原样返回
   *  （词法检查已过、无链接可解析）。 */
  private realOf(abs: string): string {
    let probe = abs;
    for (let i = 0; i < 128; i++) {
      try {
        return realpathSync(probe);
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return probe;
        probe = parent;
      }
    }
    return abs;
  }

  /** 读面路径归一（方案一：读放开——不再越根拦截/链接检查，仅词法绝对化）。
   *  写前比对状态键、Access 声明路径与 read 全走这里（统一绝对路径口径，MB-03 不变）。 */
  resolveAbs(path: string): string {
    return resolve(this.root, path);
  }

  /** 根的绝对路径（CT-04 2026-09-28 code review）：glob/grep 的「整根读」声明用字面绝对路径，
   *  替代把星号 pattern 当路径塞进 Access——调度器按 cwd resolve 后做前缀比较，模式串不参与。 */
  absRoot(): string {
    return this.root;
  }

  read(path: string): Promise<string> {
    return Promise.resolve(readFileSync(this.resolveAbs(path), "utf8"));
  }

  write(path: string, content: string): Promise<void> {
    writeFileSync(this.safeWrite(path), content, "utf8");
    return Promise.resolve();
  }

  /** glob 走查基切分（方案一：pattern 支持绝对路径/.. 直指根外）：首个含通配符的段之前 = 走查基、
   *  之后 = 相对基的匹配模式；无通配符（纯字面路径）literal——走查退化为存在性检查。 */
  static splitPattern(root: string, pattern: string): { base: string; rest: string; literal: boolean } {
    const abs = resolve(root, pattern).replace(/\\/g, "/");
    const segs = abs.split("/");
    const gi = segs.findIndex((s) => /[*?{[]/.test(s));
    if (gi < 0) return { base: resolve(abs), rest: "", literal: true };
    const basePosix = /^[a-zA-Z]:$/.test(segs[0]!) && gi === 1 ? `${segs[0]}/` : segs.slice(0, gi).join("/"); // win 裸盘根特判（"D:" ≠ "D:/"）
    return { base: resolve(basePosix), rest: segs.slice(gi).join("/"), literal: false }; // base 归原生分隔符——与 resolveAbs/Access 声明同口径
  }

  /** glob 匹配（T16）：自实现递归走查 + 模式转正则（避免 fs.glob 类型重载纠缠）。
   *  方案一（2026-10-01）：走查基随 pattern 走（根外绝对 pattern 即他仓目录），不再越根拦截；
   *  结果恒绝对路径。 */
  async globFiles(pattern: string): Promise<string[]> {
    const { base, rest, literal } = LocalFs.splitPattern(this.root, pattern);
    if (literal) {
      try {
        return statSync(base).isFile() ? [base] : [];
      } catch {
        return [];
      }
    }
    const re = globToRegExp(rest);
    const skip = new Set(["node_modules", ".git"]);
    const out: string[] = [];
    const walk = (rel: string): void => {
      const abs = join(base, rel);
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (skip.has(e.name)) continue;
        const child = rel === "" ? e.name : `${rel}/${e.name}`;
        // MB-10（2026-09-28 code review P3）：只推文件——目录不进结果（description 的 "file paths only" 落实；
        // Dirent.isFile() 对符号链接为 false（lstat 语义），链接目标不跟随——与沙箱 realpath 口径不冲突）
        if (e.isFile() && re.test(child)) out.push(join(base, child));
        if (e.isDirectory()) walk(child);
      }
    };
    walk("");
    return [...new Set(out)].sort();
  }

  /** 内容正则搜索（T16 起）：结构化命中（file 绝对路径 / 1-based 行号 / 行文本截断 200）；
   *  跳过二进制（替换率粗判）与超大文件（>1MB）。三输出模式由工具层渲染（M4-2 T6）。
   *  MB-09：返回 { matches, truncated }——命中达 GREP_MAX_MATCHES 提前停扫，truncated 供工具层标注。 */
  async grepMatches(regex: string): Promise<{ matches: { file: string; lineNo: number; text: string }[]; truncated: boolean }> {
    const re = compileGrepRegex(regex); // MB-06：先验——非法正则/嵌套量词形态在此带内抛错，不进扫描
    const out: { file: string; lineNo: number; text: string }[] = [];
    let truncated = false;
    scan: for (const p of await this.globFiles("**/*")) {
      // MB-09（2026-09-28 code review P3）：大小闸前置于读取（read 工具 MB-07 三闸同款）——
      // >1MB 的文件不再白读一遍+utf8 解码后才判跳过；stat 失败（扫描间隙文件消失）按跳过
      try {
        if (statSync(p).size > GREP_MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      let content: string;
      try {
        content = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      if (content.length > GREP_MAX_FILE_BYTES) continue; // stat 与读之间文件被写大的竞态兜底（字节≥字符，同数口径偏严不偏漏）
      const lines = content.split("\n");
      const bad = lines.filter((l) => l.includes("\uFFFD")).length;
      if (lines.length > 0 && bad > lines.length / 4) continue; // 二进制粗判
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.length > GREP_MAX_LINE) continue; // MB-06：超长行（minified/bundle）跳过——病态正则工作量上界
        if (re.test(line)) {
          out.push({ file: p, lineNo: i + 1, text: line.slice(0, 200) });
          if (out.length >= GREP_MAX_MATCHES) { // MB-09：达命中上限停扫——宽匹配的结果集与内存都有界
            truncated = true;
            break scan;
          }
        }
      }
    }
    return { matches: out, truncated };
  }
}

/** MB-06（2026-09-28 code review）：grep 正则先验——模型可控正则的两道低成本拒绝（子进程 rg 化待真实需求）：
 *  ①非法语法（new RegExp 抛 SyntaxError）→ 明确报错而非裸抛；
 *  ②嵌套量词形态（组内含量词、组本身又被量词修饰，如 (a+)+、((a|b)*)+）——V8 回溯不可中断，
 *    30 字符级行长即可指数爆炸冻结事件循环，静态检出并指引改写。合法形态（(?:ab)+、(a|b)+ 等）不受影响。 */
function compileGrepRegex(regex: string): RegExp {
  let re: RegExp;
  try {
    re = new RegExp(regex);
  } catch (err) {
    throw new Error(`正则无效（${String(err instanceof Error ? err.message : err)}）——请检查转义与语法`, { cause: err });
  }
  if (hasNestedQuantifier(regex)) {
    throw new Error("正则含嵌套量词（带量词的组又被量词修饰，如 (a+)+）——灾难性回溯会冻结整个进程，请改写：展开嵌套（a+）、去掉外层量词，或拆成多次搜索");
  }
  return re;
}

/** MB-06：静态检测嵌套量词——扫描源串跟踪组嵌套：某组体内出现过量词（含深层）且该组后跟量词即命中。
 *  字符类 [...] 内与转义字符跳过（其中的 *+?{ 是字面量）；括号不平衡交给 new RegExp 报语法错。 */
function hasNestedQuantifier(source: string): boolean {
  const stack: boolean[] = []; // 进入各组前「外层序列是否已出现量词」
  let quantified: boolean = false; // 当前层序列中是否出现过量词
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "[") { // 字符类整段跳过（^ 与紧随的 ] 均为字面量）
      i++;
      if (source[i] === "^") i++;
      if (source[i] === "]") i++;
      while (i < source.length && source[i] !== "]") { if (source[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "(") {
      stack.push(quantified);
      quantified = false;
      if (source[i + 1] === "?") { // 组前缀（(?: (?= (?! (?<= (?<! (?<name>）——其中的 ? 不是量词
        i++;
        const n = source[i + 1];
        if (n === ":" || n === "=" || n === "!" || n === "<") i++;
      }
      continue;
    }
    if (c === ")") {
      const outer = stack.pop();
      if (outer === undefined) continue; // 不平衡——new RegExp 自会报错
      const bodyQuantified: boolean = quantified;
      const q = quantifierAt(source, i + 1);
      // 量词化的组、组内又含量词 → 嵌套；外层带 ≤10 显式上界（{3}/{1,4}——多项式级非指数）放行
      if (q.len > 0 && bodyQuantified && !q.bounded) return true;
      quantified = outer || bodyQuantified || q.len > 0;
      i += q.len > 0 ? q.len - 1 : 0;
      continue;
    }
    const q = quantifierAt(source, i);
    if (q.len > 0) { quantified = true; i += q.len - 1; }
  }
  return false;
}

/** MB-06：位置 i 起是否为量词（* + ? 或成形的 {n}/{n,}/{n,m}——不成形的 { 是字面量）。
 *  len = 占用长度（0 = 非量词）；bounded = 有 ≤10 的显式重复上界——外层有界的嵌套是多项式级（如 IPv4 的
 *  (\d+\.){3}\d+），不是指数回溯，放行。 */
function quantifierAt(source: string, i: number): { len: number; bounded: boolean } {
  const c = source[i];
  if (c === "*" || c === "+" || c === "?") return { len: 1, bounded: false };
  if (c === "{") {
    const m = /^\{(\d+)(,\d*)?\}/.exec(source.slice(i));
    if (m) {
      const upper = m[2] === undefined ? Number(m[1]) : m[2] === "," ? Number.POSITIVE_INFINITY : Number(m[2]!.slice(1));
      return { len: m[0].length, bounded: upper <= 10 };
    }
  }
  return { len: 0, bounded: false };
}

/** MB-06：grep 单行匹配长度上限——超长行（minified/bundle 常态）跳过，工作量与多项式病态正则的基都被压住。 */
const GREP_MAX_LINE = 4096;

/** MB-09（2026-09-28 code review）：grep 文件大小闸（字节）——statSync 前置于 readFileSync（>1MB 跳过，
 *  与 read 整读上限 READ_MAX_BYTES 同口径）：大文件不再整读+解码一遍之后才判跳过（白读）。 */
const GREP_MAX_FILE_BYTES = 1_048_576;

/** MB-09：grep 命中条数上限——宽匹配（pattern="."）不再攒出数十万条命中与拼接串；达限停扫，工具层标注截断。 */
const GREP_MAX_MATCHES = 200;

/** ---- 敏感文件黑名单（2026-10-01 批 C 拍板「学 kimi」，逐项照抄 kimi-code path-access.ts:15-81）----
 *  读面放开后的防线：.env 系 / SSH 私钥系 / credentials 系命中 → read 带内拒绝（审批面暂无「敏感读询问」
 *  语义——Access 只有四形态、工具无法主动触发弹问，v1 以硬拒+放行指引近似 kimi 的 ask，契约窗口再升级）；
 *  glob/grep 结果命中 → 静默过滤并计数（kimi globTool.ts:233-240 / grepTool.ts:658-662 同款）。 */
const SENSITIVE_BASENAMES = new Set([".env", "id_rsa", "id_ed25519", "id_ecdsa", "credentials"]);
const SENSITIVE_NAME_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", "credentials"];
const SENSITIVE_DOT_VARIANTS = new Set([".bak", ".backup", ".copy", ".disabled", ".key", ".old", ".orig", ".pem", ".save", ".tmp"]);
const ENV_EXEMPTIONS = new Set([".env.example", ".env.sample", ".env.template"]);
const PUBLIC_KEY_BASENAMES = new Set(["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub"]);
const SENSITIVE_PATH_SUFFIXES = [".aws/credentials", ".gcp/credentials"];

/** 敏感文件判定（kimi isSensitivePath 同款口径，全程小写比较）：basename 精确命中 / .env.* 前缀 /
 *  密钥名连接变体（-xxx、_xxx、.bak/.pem 等点变体；公钥 .pub 豁免）/ .aws|.gcp credentials 路径后缀。 */
export function isSensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  const full = path.toLowerCase().replace(/\\/g, "/");
  if (ENV_EXEMPTIONS.has(name) || PUBLIC_KEY_BASENAMES.has(name)) return false;
  if (SENSITIVE_BASENAMES.has(name)) return true;
  if (name.startsWith(".env.")) return true;
  for (const p of SENSITIVE_NAME_PREFIXES) {
    if (name.length > p.length && name.startsWith(p)) {
      const suffix = name.slice(p.length);
      const next = suffix[0]!;
      if (next === "-" || next === "_") return true;
      if (next === "." && SENSITIVE_DOT_VARIANTS.has(suffix)) return true;
    }
  }
  for (const sfx of SENSITIVE_PATH_SUFFIXES) {
    if (full.endsWith(`/${sfx}`) || full.includes(`/${sfx}/`)) return true;
  }
  return false;
}

const SENSITIVE_DENY_NOTE = "敏感文件（.env/密钥/凭证类）默认拒绝读取——防密钥泄漏进模型上下文。如任务确需此文件内容，请询问用户、由用户直接提供";

/** glob 模式 → 锚定正则：** 跨段、* 单段内、? 单字符（相对走查基的 posix 风格路径）。 */
function globToRegExp(pattern: string): RegExp {
  const segs = pattern.split("/");
  const body = segs.map((seg) => {
    if (seg === "**") return "(?:.+)?";
    const esc = seg
      .replace(/[.+^$()|[\]]/g, (c) => "\\" + c)
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    return esc;
  }).join("/");
  const anchored = body.split("(?:.+)?/").join("(?:.+/)?"); // **/ 的斜杠可省——顶层文件也命中
  return new RegExp(`^${anchored}$`);
}

const pathParam = { path: z.string().describe("相对工作目录的路径（read 也接受绝对路径——可读工作目录外的文件；写仍限工作目录内）") };

/** read 缺省窗口（M4-2.5 T0，opencode/pi 同款）：模型得连贯首段+续读提示；日志侧坍缩靠 mtime 去重。 */
const READ_DEFAULT_WINDOW = 2000;

/** MB-07（2026-09-28 code review）：read 整读大小闸——>1MB（1_048_576B，与 grep 跳过口径一致）拒绝整读改指引。 */
const READ_MAX_BYTES = 1_048_576;

/** MB-07：read 单行输出上限——>8KB（8192 字符）截断并标注（报告建议值）。 */
const READ_MAX_LINE = 8192;

/** CT-04（2026-09-28 code review）：Access.path 语义 = 字面文件系统路径（绝对或按声明方 root 归一）——
 *  本模块统一 resolveAbs 成绝对路径再声明；解析失败（越出根等）回落原始串，execute 内自会带内报错。 */
const declaredPath = (fs: LocalFs, path: string): string => {
  try {
    return fs.resolveAbs(path);
  } catch {
    return path;
  }
};

/**
 * 写前比对状态（M4.5 T7②——决策 24④，cc readFileState 同族）：path → 上次读取时的 mtime（+全量读的内容快照）。
 * 模块级共享（read 记 / write·edit 查并刷新）——主对话与所有子代理同图同工具实例，天然互相看得见：
 * A 读过、B 改了、A 再写 = 被拦要求重读（「读后被改还按旧印象覆盖」正是写乱的主因）。
 * 写成功后刷新记录——自己连续写（write→edit）不会被自己的写拦住。
 */
type ReadState = Map<string, { mtimeMs: number; content?: string }>;

/** 写前比对：目标文件修改时间跟「上次读它时记的」对不上就拒绝、要求重读。
 *  Windows 修改时间偶尔漂移——全量读过的回退内容比对（一致 = 漂移，放行并刷新记录）。
 *  MB-03（2026-09-28 code review）：键统一经 resolveAbs 归一为绝对路径——read("a.ts") 记的记录，
 *  write("./a.ts")（拼写变体）查的是同一条，不再绕过写前比对。 */
const writeGuard = async (fs: LocalFs, path: string, readState: ReadState): Promise<string | undefined> => {
  const abs = fs.resolveAbs(path);
  const prior = readState.get(abs);
  if (prior === undefined) return undefined; // 从没读过（新建文件）——没有「旧印象」可覆盖，不拦
  let mtime: number;
  try {
    mtime = statSync(abs).mtimeMs;
  } catch {
    return undefined; // 文件已不在（删后重写）——旧印象无对象
  }
  if (mtime === prior.mtimeMs) return undefined;
  if (prior.content !== undefined) {
    try {
      if ((await fs.read(abs)) === prior.content) {
        readState.set(abs, { mtimeMs: mtime, content: prior.content }); // mtime 漂移但内容没变——刷新记录放行
        return undefined;
      }
    } catch { /* 读失败 → 走拦截 */ }
  }
  return `文件在读取后被修改过（${path}）——先重新读取最新内容再写（防按旧印象覆盖别人的改动）`;
};

/** 写成功后刷新记录：mtime 记新值（后续写不拦），内容快照记刚写的已知内容（漂移回退可比对）。
 *  MB-03：键同 writeGuard——resolveAbs 归一的绝对路径（拼写变体同键）。 */
const noteWrite = (fs: LocalFs, path: string, readState: ReadState, knownContent?: string): void => {
  let abs: string;
  try {
    abs = fs.resolveAbs(path);
  } catch {
    return; // 键解析失败（越出根等）——无键可记（写路径自身会带内报错，这里不二次抛）
  }
  try {
    readState.set(abs, { mtimeMs: statSync(abs).mtimeMs, ...(knownContent !== undefined ? { content: knownContent } : {}) });
  } catch {
    readState.delete(abs);
  }
};

function readTool(fs: LocalFs, readState: ReadState): Tool {
  // mtime 去重状态（cc readFileState 同款）：键 = 归一绝对路径+offset+limit，值 = mtimeMs——文件被改即失效
  const lastRead = new Map<string, number>();
  return defineTool({
    name: "tool-fs__read",
    description: "Read file contents with optional line range. Results include line numbers (N→text format).\nUse this tool — not shell commands like cat/head/tail — to inspect text files.\nAbsolute paths are accepted and may point outside the working directory (e.g. other local repos the user referenced); writes stay confined to the working directory.\nSensitive files (.env / SSH keys / credentials, incl. variants) are denied by default — ask the user to provide such content directly if truly needed.\nParameters:\n  path: Relative path (or absolute path) to the file\n  offset: 1-based starting line number (optional)\n  limit: Maximum number of lines to return (optional)\nDefaults to the first 2000 lines; use offset (e.g. offset=2001) for continuation.\nRe-reading an unchanged file with the same range returns a file_unchanged notice instead of repeating content.\nFiles larger than 1MB are rejected (use grep to locate content or shell tools to read sections); binary files are rejected.\nLines longer than 8KB are truncated.",
    parameters: z.object({
      ...pathParam,
      offset: z.number().int().positive().optional().describe("起始行号（1-based）"),
      limit: z.number().int().positive().optional().describe("返回的最大行数"),
    }),
    resolveExecution: async (input) => {
      const { path, offset, limit } = input as { path: string; offset?: number; limit?: number };
      return {
        // CT-04（2026-09-28 code review）：Access.path 收字面文件系统路径——相对路径按本模块 root 归一为绝对路径再声明，
        // 不与调度器按 cwd 归一的基准错位；解析失败回落原始串（execute 内自会带内报错）
        accesses: [Access.fsRead(declaredPath(fs, path))],
        approvalRule: "tool-fs__read",
        execute: async () => {
          try {
            const abs = fs.resolveAbs(path); // MB-03：状态键统一绝对路径（拼写变体同键）
            if (isSensitivePath(abs)) {
              return { output: `已拒绝读取 ${path}：${SENSITIVE_DENY_NOTE}`, isError: true };
            }
            const st = statSync(abs);
            const key = `${abs}:${offset ?? 1}:${limit ?? "d"}`; // MB-03：去重键以归一路径为基
            if (lastRead.get(key) === st.mtimeMs) {
              return { output: `(file_unchanged：${path} 内容与上次读取相同，未重复注入——重看请换行区间)`, isError: false };
            }
            // MB-07（2026-09-28 code review）：大文件闸——statSync 前置于整读，>1MB（与 grep 跳过口径一致）不整读，
            // 带内指引改道（巨型日志/minified bundle 的同步阻塞与内存翻倍从入口掐断）
            if (st.size > READ_MAX_BYTES) {
              return {
                output: `文件过大（${(st.size / 1_048_576).toFixed(1)}MB，超过 1MB 整读上限）——已跳过读取。请用 tool-fs__grep 定位内容，或 shell 分段读取（head/tail/sed -n '起,止p'）`,
                isError: true,
              };
            }
            const content = await fs.read(abs);
            // MB-07：二进制判定——首 8KB 含 NUL 或 U+FFFD 替换率过高（grep 同款粗判）→ 明确提示，不注入乱码
            const head = content.slice(0, 8192);
            const bad = head.match(/\uFFFD/g)?.length ?? 0;
            if (head.includes("\u0000") || bad > head.length / 4) {
              return { output: `文件疑似二进制（${path}）——read 只处理文本；请用 glob 确认文件后改用 shell 或专用工具`, isError: true };
            }
            const lines = content.split("\n").filter((_, i, arr) => i < arr.length - 1 || arr[i] !== ""); // 去尾空段
            const start = (offset ?? 1) - 1;
            if (start >= lines.length) {
              return { output: `文件共 ${lines.length} 行，offset 超界（offset = ${offset ?? 1}）`, isError: false };
            }
            const effectiveLimit = limit ?? Math.min(READ_DEFAULT_WINDOW, lines.length - start);
            const slice = lines.slice(start, start + effectiveLimit);
            const truncatedTail = start + slice.length < lines.length;
            // MB-07：单行超长（>8KB，minified 常态）截断并标注——不整行注入
            const numbered = slice.map((text, i) => {
              const shown = text.length > READ_MAX_LINE ? text.slice(0, READ_MAX_LINE) + `…（行超长，已截断：原 ${text.length} 字符）` : text;
              return `${start + i + 1}→${shown}`;
            }).join("\n");
            const footer = truncatedTail
              ? `\n(共 ${lines.length} 行，已显示 ${start + 1}-${start + slice.length}——续读请带 offset=${start + slice.length + 1}，或 offset+limit 读区间)`
              : `\n(第 ${start + 1}-${start + slice.length} 行，共 ${lines.length} 行)`;
            lastRead.set(key, st.mtimeMs);
            const wholeFile = start === 0 && !truncatedTail; // 全量读过 → 记内容快照（写前比对的漂移回退用）
            readState.set(abs, { mtimeMs: st.mtimeMs, ...(wholeFile ? { content } : {}) }); // MB-03：键 = 归一绝对路径
            return { output: numbered + footer, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

function writeTool(fs: LocalFs, readState: ReadState): Tool {
  return defineTool({
    name: "tool-fs__write",
    description: "Create a new file or completely replace an existing file's contents.\nUse this tool — not shell echo/redirection or heredocs — to create or overwrite files.\nFor targeted changes to existing files, prefer edit instead (read the file first).",
    parameters: z.object({ ...pathParam, content: z.string() }),
    resolveExecution: async (input) => {
      const { path, content } = input as { path: string; content: string };
      return {
        accesses: [Access.fsWrite(declaredPath(fs, path))], // CT-04：字面绝对路径声明（按本模块 root 归一）
        approvalRule: "tool-fs__write",
        execute: async () => {
          try {
            const guard = await writeGuard(fs, path, readState); // 写前比对（决策 24④）
            if (guard !== undefined) return { output: guard, isError: true };
            await fs.write(path, content);
            noteWrite(fs, path, readState, content);
            return { output: `已写入 ${path}（${content.length}B）`, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

function editTool(fs: LocalFs, readState: ReadState): Tool {
  return defineTool({
    name: "tool-fs__edit",
    description: "Make precise text replacements in a file using exact oldText matching.\nUse this tool — not sed/awk — for targeted file edits.\nAll edits are matched against the ORIGINAL file simultaneously (not incrementally).\nEach edit's oldText must appear exactly once, unless replaceAll is set.\nIf two edits overlap, the call fails — merge them or target disjoint regions.\nCRLF-tolerant: on CRLF files, \\n-only line breaks in oldText/newText are auto-normalized to the file's style.",
    parameters: z.object({
      ...pathParam,
      edits: z.array(z.object({
        oldText: z.string().describe("待替换的精确文本"),
        newText: z.string().describe("替换后的文本"),
        replaceAll: z.boolean().optional().describe("替换全部出现（不参与唯一性/重叠检测）"),
      })).min(1).describe("编辑列表——全部基于原文件匹配，不得重叠"),
    }),
    resolveExecution: async (input) => {
      const { path, edits } = input as { path: string; edits: { oldText: string; newText: string; replaceAll?: boolean }[] };
      return {
        accesses: [Access.fsWrite(declaredPath(fs, path))], // CT-04：字面绝对路径声明（按本模块 root 归一）
        approvalRule: "tool-fs__edit",
        execute: async () => {
          try {
            const guard = await writeGuard(fs, path, readState); // 写前比对（决策 24④）——edit 自带的现读不替代模型侧的读记录
            if (guard !== undefined) return { output: guard, isError: true };
          const before = await fs.read(path);
          // CRLF 容差（2026-10-01 实机「未找到待替换文本」连报根因）：core.autocrlf=true 的机器上经 git
          // 检出的文件工作树是 CRLF——Read 按行展示时行尾 \r 不可见，模型复述的多行 oldText 只会是 \n，
          // 裸字节匹配必败。先按原样精确匹配（混合行尾文件的 LF 区段不受扰），未中且文件含 \r\n 时把
          // oldText 换行扩成 \r\n 再试；此路命中则 newText 同步归一，不往 CRLF 文件里掺 LF。
          const hasCrlf = before.includes("\r\n");
          const expand = (s: string): string => s.replace(/\r?\n/g, "\r\n");
          const positions: { start: number; end: number; newText: string; index: number }[] = [];
          for (let i = 0; i < edits.length; i++) {
            const e = edits[i]!;
            if (e.replaceAll === true) continue; // 全替换不参与位置检测
            let oldText = e.oldText;
            let newText = e.newText;
            let pos = before.indexOf(oldText);
            if (pos < 0 && hasCrlf) {
              const expanded = expand(e.oldText);
              if (expanded !== e.oldText && before.indexOf(expanded) >= 0) {
                oldText = expanded;
                newText = expand(e.newText);
                pos = before.indexOf(expanded);
              }
            }
            if (pos < 0) {
              // 报错带线索（实机教训：光一句「未找到」模型只会微调重试连败）——说破 EOL 适配已试过、
              // 从未读过的文件提醒先读（writeGuard 对没读过的文件放行，这里补一句指路）
              const hints: string[] = [];
              if (hasCrlf) hints.push("本文件为 CRLF 行尾——多行片段已自动按 \\r\\n 适配仍未命中，请逐字对照最新读取内容");
              if (readState.get(fs.resolveAbs(path)) === undefined) hints.push("本会话尚未读取过该文件——先 tool-fs__read 再编辑");
              return { output: `edits[${i}]: 未找到待替换文本${hints.length > 0 ? `（${hints.join("；")}）` : ""}`, isError: true };
            }
            if (before.indexOf(oldText, pos + 1) >= 0) {
              return { output: `edits[${i}]: 多处匹配——请提供更长的唯一片段或设 replaceAll`, isError: true };
            }
            positions.push({ start: pos, end: pos + oldText.length, newText, index: i });
          }
            // 重叠检测（pi 原文件匹配方案核心）
            positions.sort((a, b) => a.start - b.start);
            for (let i = 1; i < positions.length; i++) {
              if (positions[i]!.start < positions[i - 1]!.end) {
                return {
                  output: `edits[${positions[i - 1]!.index}] 和 edits[${positions[i]!.index}] 重叠——合并为一个 edit 或选不重叠的区域`,
                  isError: true,
                };
              }
            }
            // 从原文件一次性应用（不基于中间结果）。MB-11（2026-09-28 code review P3）：replaceAll 同样基于
            // 原文件——只作用于位置编辑未触及的原文区段：位置编辑插入的 newText 不被二次替换、replaceAll 的
            // 匹配不跨位置编辑接缝拼串（与 description「All edits are matched against the ORIGINAL file
            // simultaneously」对齐；旧实现对已应用位置编辑的结果串再跑 split/join，是增量的）
            const applyReplaceAll = (segment: string): string => {
              for (const e of edits) {
                if (e.replaceAll !== true) continue;
                // 同款 CRLF 容差（文件级判定：原样在文件里存在就按原样，否则试扩展形态——
                // 混合行尾文件原样优先；newText 随命中形态归一）
                const expanded = hasCrlf ? expand(e.oldText) : e.oldText;
                const useExpanded = expanded !== e.oldText && !before.includes(e.oldText);
                segment = segment.split(useExpanded ? expanded : e.oldText).join(useExpanded ? expand(e.newText) : e.newText);
              }
              return segment;
            };
            let result = "";
            let cursor = 0;
            for (const p of positions) {
              result += applyReplaceAll(before.slice(cursor, p.start)) + p.newText;
              cursor = p.end;
            }
            result += applyReplaceAll(before.slice(cursor));
            await fs.write(path, result);
            noteWrite(fs, path, readState, result);
            const count = positions.length + edits.filter((e) => e.replaceAll === true).length;
            return { output: `已编辑 ${path}（${count} 处）`, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

function globTool(fs: LocalFs): Tool {
  return defineTool({
    name: "tool-fs__glob",
    description: "Find files by glob pattern. Results are file paths only (directories excluded).\nUse this tool — not shell find or ls — to discover files by name pattern.\nPatterns resolve against the working directory; absolute-path patterns (or ../) target directories outside it — the walk starts at the longest glob-free directory prefix (e.g. D:/other/repo/src/**/*.ts).\nSensitive files (.env / SSH keys / credentials) are filtered out of results.\nSkips node_modules and .git directories only — other ignore rules are NOT applied (dist/ and coverage/ are traversed). head_limit to cap results (default 100).",
    parameters: z.object({
      pattern: z.string().describe("glob 模式（相对工作目录，或绝对路径直指他仓）"),
      head_limit: z.number().int().positive().optional().describe("返回的最大条数（缺省 100）"),
    }),
    resolveExecution: async (input) => {
      const { pattern, head_limit } = input as { pattern: string; head_limit?: number };
      return {
        // CT-04 + 方案一：声明随走查基如实——根内 pattern 基 = 根（或其子目录）、根外绝对 pattern 基 = 外部目录
        accesses: [Access.fsRead(LocalFs.splitPattern(fs.absRoot(), pattern).base)],
        approvalRule: "tool-fs__glob",
        execute: async () => {
          try {
            const all = await fs.globFiles(pattern);
            const kept = all.filter((p) => !isSensitivePath(p));
            const filtered = all.length - kept.length;
            const limit = head_limit ?? 100;
            const shown = kept.slice(0, limit);
            const footer = kept.length > limit ? `\n(共 ${kept.length} 条，仅显示前 ${limit} 条)` : "";
            const note = filtered > 0 ? `\n(已过滤 ${filtered} 个敏感文件——.env/密钥/凭证类不进结果)` : "";
            return { output: (shown.length > 0 ? shown.join("\n") : "（无匹配）") + footer + note, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

function grepTool(fs: LocalFs): Tool {
  return defineTool({
    name: "tool-fs__grep",
    description: "Search file contents by JavaScript regex pattern.\nUse this tool — not shell grep or rg — to search file contents.\nScans the working directory tree (to search another local repo, use glob with an absolute pattern there, or read its files directly).\nSensitive files (.env / SSH keys / credentials) are excluded from results.\noutput_mode: \"content\" (path:line:text), \"files_with_matches\" (paths only), or \"count\".\nUse files_with_matches to locate files, then read for context.\nInvalid or nested-quantifier regexes (e.g. (a+)+) are rejected; lines longer than 4096 chars are skipped.\nFiles over 1MB are skipped; matches are capped at 200 (truncated with a note — narrow the pattern).",
    parameters: z.object({
      pattern: z.string().describe("JavaScript 正则"),
      output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("输出格式（缺省 content）"),
    }),
    resolveExecution: async (input) => {
      const { pattern, output_mode } = input as { pattern: string; output_mode?: "content" | "files_with_matches" | "count" };
      return {
        // CT-04：grep 扫全根——声明字面绝对根路径（原 **/* 被调度器 resolve 成 <cwd>/**/* 字面串，恒不与写冲突）
        accesses: [Access.fsRead(fs.absRoot())],
        approvalRule: "tool-fs__grep",
        execute: async () => {
          try {
            const { matches: all, truncated } = await fs.grepMatches(pattern);
            const matches = all.filter((m) => !isSensitivePath(m.file));
            const filtered = new Set(all.filter((m) => isSensitivePath(m.file)).map((m) => m.file)).size;
            let body: string;
            if (output_mode === "files_with_matches") {
              body = [...new Set(matches.map((m) => m.file))].join("\n");
            } else if (output_mode === "count") {
              const perFile = new Map<string, number>();
              for (const m of matches) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
              body = [...perFile].map(([f, n]) => `${f}: ${n}`).join("\n");
            } else {
              body = matches.map((m) => `${m.file}:${m.lineNo}:${m.text}`).join("\n");
            }
            // MB-09：命中达上限时的截断标注（truncated ⇒ body 必非空；count/files 模式的数字同样基于截断集）
            const note = truncated
              ? `\n(命中过多：已达 ${GREP_MAX_MATCHES} 条上限，仅保留先扫到的部分——请收窄 pattern 或改用更精确的定位)`
              : "";
            const sensNote = filtered > 0 ? `\n(已跳过 ${filtered} 个敏感文件——.env/密钥/凭证类不进结果)` : "";
            return { output: (body !== "" ? body : "（无匹配）") + note + sensNote, isError: false };
          } catch (err) {
            return { output: String(err instanceof Error ? err.message : err), isError: true };
          }
        },
      };
    },
  });
}

export default defineModule({
  name: "tool-fs",
  version: "0.1.0",
  description: "本地文件系统工具（read/write/edit/glob/grep）与 fs 能力",
  api: 1,
  provides: [FS],
  uses: ["fs.read", "fs.write"],
  activate(ctx) {
    // M1：根 = 进程 cwd；root 配置项待真实需求出现时经本模块 config schema 加入
    const fs = new LocalFs(process.cwd());
    const readState: ReadState = new Map(); // 写前比对共享状态（read 记 / write·edit 查——M4.5 T7②）
    ctx.provide(FS, fs);
    ctx.contribute.tool(readTool(fs, readState));
    ctx.contribute.tool(writeTool(fs, readState));
    ctx.contribute.tool(editTool(fs, readState));
    ctx.contribute.tool(globTool(fs));
    ctx.contribute.tool(grepTool(fs));
  },
});
