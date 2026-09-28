import { describe, it, expect } from "vitest";
import { Access } from "@orosus/contracts/tool";
import { decide, isSensitivePath, type ApprovalRule } from "./decide.ts";
import { analyzeDangerous } from "./dangerous.ts";

const noMemory = (): boolean => false;

const run = (over: {
  mode: "ask-always" | "ask-risky" | "never";
  rules?: ApprovalRule[];
  name?: string;
  approvalRule?: string;
  accesses?: Access[];
  matchesRule?: (a: string) => boolean;
  sessionAllowed?: (k: string) => boolean;
}) =>
  decide({
    mode: over.mode,
    rules: over.rules ?? [],
    name: over.name ?? "m__t",
    approvalRule: over.approvalRule ?? "m__t",
    accesses: over.accesses ?? [Access.all()],
    sessionAllowed: over.sessionAllowed ?? noMemory,
    ...(over.matchesRule !== undefined ? { matchesRule: over.matchesRule } : {}),
  });

describe("decide——模式基线（D36 三档）", () => {
  it("ask-risky（出厂默认）：fs.read/fs.write 常规放行；subprocess 询问；network 放行（D36 表字面）；kind:all 询问", () => {
    expect(run({ mode: "ask-risky", accesses: [Access.fsRead("/a.ts")] })).toMatchObject({ effect: "allow" });
    expect(run({ mode: "ask-risky", accesses: [Access.fsWrite("/a.ts")] })).toMatchObject({ effect: "allow" });
    expect(run({ mode: "ask-risky", accesses: [Access.subprocess()] })).toMatchObject({ effect: "ask", memoryKey: "m__t" });
    expect(run({ mode: "ask-risky", accesses: [Access.network("api.x.com")] })).toMatchObject({ effect: "allow" });
    expect(run({ mode: "ask-risky", accesses: [Access.all()] })).toMatchObject({ effect: "ask" });
  });

  it("ask-always：仅 fs.read 放行，fs.write/subprocess/network/all 一律询问", () => {
    expect(run({ mode: "ask-always", accesses: [Access.fsRead("/a"), Access.fsRead("/b")] })).toMatchObject({ effect: "allow" });
    for (const a of [[Access.fsWrite("/a")], [Access.subprocess()], [Access.network("h")], [Access.all()], [Access.fsRead("/a"), Access.fsWrite("/b")]] as const) {
      expect(run({ mode: "ask-always", accesses: [...a] })).toMatchObject({ effect: "ask" });
    }
  });

  it("never：全自动放行一切（含危险/不可分析命令——2026-09-22 学 kimi auto 档语义，推翻 D36 自杀开关；用户显式 deny 规则仍最优先）", () => {
    expect(run({ mode: "never", accesses: [Access.subprocess()] })).toMatchObject({ effect: "allow" });
    expect(run({ mode: "never", accesses: [Access.all()] })).toMatchObject({ effect: "allow" });
    expect(run({ mode: "never", approvalRule: "tool-shell__bash(rm -rf /)", accesses: [Access.subprocess()] })).toMatchObject({ effect: "allow" }); // 危险门 never 短路
    expect(run({ mode: "never", approvalRule: "tool-shell__bash(echo $HOME/*.ts)", accesses: [Access.subprocess()] })).toMatchObject({ effect: "allow" }); // unanalyzable 同放
    // 显式 deny 规则优先于 never（kimi 链同序：UserConfiguredDeny 在 AutoModeApprove 前）
    expect(run({ mode: "never", accesses: [Access.subprocess()], name: "tool-shell__bash", rules: [{ effect: "deny", tool: "tool-shell__bash" }] })).toMatchObject({ effect: "deny", source: "rule" });
  });
});

describe("decide——用户规则（优先于模式，配置序首条命中即止）", () => {
  it("allow 放行 subprocess；deny 否决 fs.read；首条命中即止", () => {
    expect(run({
      mode: "ask-risky", accesses: [Access.subprocess()], name: "tool-shell__bash",
      rules: [{ effect: "allow", tool: "tool-shell__bash" }],
    })).toMatchObject({ effect: "allow", source: "rule" });
    expect(run({
      mode: "ask-risky", accesses: [Access.fsRead("/a")],
      rules: [{ effect: "deny", tool: "m__t" }],
    })).toMatchObject({ effect: "deny", source: "rule" });
    expect(run({
      mode: "ask-risky", accesses: [Access.subprocess()],
      rules: [{ effect: "allow", tool: "m__t" }, { effect: "deny", tool: "m__t" }], // 首条 allow 生效
    })).toMatchObject({ effect: "allow", source: "rule" });
  });

  it("带参规则经 matchesRule 判定：命中 allow 放行；不匹配回基线；无 matchesRule 的带参规则不匹配（fail-closed）", () => {
    expect(run({
      mode: "ask-risky", accesses: [Access.subprocess()], name: "tool-shell__bash", approvalRule: "tool-shell__bash(git status)",
      rules: [{ effect: "allow", tool: "tool-shell__bash(git *)" }],
      matchesRule: (a) => a === "git *",
    })).toMatchObject({ effect: "allow", source: "rule" });
    expect(run({
      mode: "ask-risky", accesses: [Access.subprocess()], name: "tool-shell__bash", approvalRule: "tool-shell__bash(rm x)",
      rules: [{ effect: "allow", tool: "tool-shell__bash(git *)" }],
      // 工具侧 mini-glob 语义（同 tool-shell）：命令 "rm x" 不匹配规则参数 "git *"
      matchesRule: (a) => (a.endsWith("*") ? "rm x".startsWith(a.slice(0, -1)) : a === "rm x"),
    })).toMatchObject({ effect: "ask", source: "mode" });
    expect(run({
      mode: "ask-risky", accesses: [Access.subprocess()], name: "tool-shell__bash",
      rules: [{ effect: "allow", tool: "tool-shell__bash(git *)" }], // 工具未提供 matchesRule
    })).toMatchObject({ effect: "ask", source: "mode" });
  });
});

describe("decide——危险命令与敏感路径（ask-risky 细化）", () => {
  it("危险命令（AST）：命中询问且 memoryKey=null（永不进会话记忆，已记忆也仍询问）；安全临时目录 rm 放行（kimi 语义）", () => {
    expect(analyzeDangerous("rm -rf /")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("rm -rf ~/proj")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("git push --force origin")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("echo hello")).toBeUndefined();
    expect(analyzeDangerous("rm -rf /tmp/x")).toBeUndefined(); // 安全临时根（/tmp）——AST 语义比正则 v1 精确
    const d = run({ mode: "ask-risky", name: "tool-shell__bash", approvalRule: "tool-shell__bash(rm -rf /)", accesses: [Access.subprocess()] });
    expect(d).toMatchObject({ effect: "ask", memoryKey: null });
    const d2 = run({
      mode: "ask-risky", name: "tool-shell__bash", approvalRule: "tool-shell__bash(rm -rf /)", accesses: [Access.subprocess()],
      sessionAllowed: () => true, // 即使会话有记忆
    });
    expect(d2).toMatchObject({ effect: "ask" });
  });

  it("AST ①：嵌套 shell 内的危险命令——$() 节点递归收集 + sh -c 载荷递归（含合法双层引用）", () => {
    expect(analyzeDangerous("echo $(rm -rf /)")).toMatchObject({ kind: "dangerous" }); // command substitution 内的 command 节点被收集
    expect(analyzeDangerous("bash -c 'shutdown'")).toMatchObject({ kind: "dangerous" }); // 单层载荷递归
    expect(analyzeDangerous("bash -c \"sh -c 'rm -rf /'\"")).toMatchObject({ kind: "dangerous" }); // 合法双层（双包单）
  });

  it("AST ②：sudo/doas 特权包装命中（sudo shutdown → 递归到 inner）", () => {
    expect(analyzeDangerous("sudo shutdown")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("doas rm -rf /home")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("sudo ls")).toBeUndefined(); // 特权包装本身不必然危险——递归看内层
  });

  it("AST ③：节点预算 abort → fail-closed 询问（unanalyzable）", () => {
    const huge = `echo ${"token ".repeat(30000)}`; // 超 1 万节点预算 → parse abort（word 节点约 3 万）
    const verdict = analyzeDangerous(huge);
    expect(verdict).toMatchObject({ kind: "unanalyzable" });
    expect(run({ mode: "ask-risky", name: "tool-shell__bash", approvalRule: `tool-shell__bash(${huge})`, accesses: [Access.subprocess()] })).toMatchObject({ effect: "ask", memoryKey: null }); // unanalyzable 同样 fail-closed 询问
  });

  it("AST ④：cmd 方言输入（del /s /q）→ 双保险 pattern 命中询问（win32 tool-shell 走 cmd.exe）", () => {
    expect(analyzeDangerous("del /s /q C:/x")).toMatchObject({ kind: "dangerous", command: "del /s" });
    expect(analyzeDangerous("rd /s /q C:/x")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("del C:/single.txt")).toBeUndefined(); // 无 /s 递归标志——非危险
  });

  it("AST ⑤ MA-06 回归钉（2026-09-28 code review）：git 取值选项 / chmod 长格式递归旗标逃逸——三形态判危险", () => {
    // MA-06①：`git -C /repo push --force`——旧实现取「首个非 - 参数」把 -C 的值 /repo 当子命令，判安全（实测 undefined）
    expect(analyzeDangerous("git -C /repo push --force")).toMatchObject({ kind: "dangerous", command: "git push --force" });
    // MA-06②：`git --git-dir /x push -f` 同形态（长格式取值选项，实测 undefined）
    expect(analyzeDangerous("git --git-dir /x push -f")).toMatchObject({ kind: "dangerous", command: "git push --force" });
    // MA-06③：`chmod --recursive 777 /data`——旧正则 /^-[a-zA-Z]*R/ 不匹配 GNU 长选项（实测 undefined）
    expect(analyzeDangerous("chmod --recursive 777 /data")).toMatchObject({ kind: "dangerous", command: "chmod -R" });
    expect(analyzeDangerous("chown --recursive u:g /data")).toMatchObject({ kind: "dangerous", command: "chown -R" });
    // 对照组（修复前即判危险——运行时验证过的既有行为，防回归）
    expect(analyzeDangerous("git push --force")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("git reset --hard")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("chmod -R 777 /data")).toMatchObject({ kind: "dangerous" });
    expect(analyzeDangerous("chown -R u:g /data")).toMatchObject({ kind: "dangerous" });
    // 防误伤：取值选项后的良性 git（status / 无 force 的 push / -c 配置覆盖）、非递归 chmod 仍安全
    expect(analyzeDangerous("git -C /repo status")).toBeUndefined();
    expect(analyzeDangerous("git --git-dir=/x/.git status")).toBeUndefined(); // = 自带值形态
    expect(analyzeDangerous("git -c http.sslVerify=false push origin main")).toBeUndefined();
    expect(analyzeDangerous("git commit -m 'push --force text'")).toBeUndefined();
    expect(analyzeDangerous("chmod 644 a.txt")).toBeUndefined();
    // decide 管线口径：逃逸形态照常走危险门——memoryKey=null（永不进会话记忆），全会话记忆也拦不住询问
    const d = run({
      mode: "ask-risky", name: "tool-shell__bash", approvalRule: "tool-shell__bash(git -C /repo push --force)",
      accesses: [Access.subprocess()], sessionAllowed: () => true,
    });
    expect(d).toMatchObject({ effect: "ask", memoryKey: null });
  });

  it("敏感路径写询问（可记忆，MA-05：记忆键逐路径）；普通写放行；敏感读不触发（D36 表：敏感路径写）", () => {
    expect(isSensitivePath("/repo/.env")).toBe(true);
    expect(isSensitivePath("/repo/.env.local")).toBe(true);
    expect(isSensitivePath("/home/u/.ssh/id_rsa")).toBe(true);
    expect(isSensitivePath("/repo/.git/config")).toBe(true);
    expect(isSensitivePath("/repo/src/a.ts")).toBe(false);
    // MA-05 回归钉（2026-09-28 code review）：记忆键带路径 `sensitive:<工具名>:<路径>`——
    // 旧键 sensitive:m__t 按工具不按路径，批一次 .env 后同会话 .ssh/.aws 写共享一把钥匙静默放行
    expect(run({ mode: "ask-risky", accesses: [Access.fsWrite("/repo/.env")] })).toMatchObject({ effect: "ask", memoryKey: "sensitive:m__t:/repo/.env" });
    expect(run({
      mode: "ask-risky", accesses: [Access.fsWrite("/repo/.env")],
      sessionAllowed: (k) => k === "sensitive:m__t:/repo/.env",
    })).toMatchObject({ effect: "allow", source: "memory" });
    // MA-05 回归钉：.env 的会话记忆不覆盖 ~/.ssh/id_rsa——另一条敏感写键不同，仍询问
    expect(run({
      mode: "ask-risky", accesses: [Access.fsWrite("/home/u/.ssh/id_rsa")],
      sessionAllowed: (k) => k === "sensitive:m__t:/repo/.env",
    })).toMatchObject({ effect: "ask", memoryKey: "sensitive:m__t:/home/u/.ssh/id_rsa" });
    expect(run({ mode: "ask-risky", accesses: [Access.fsWrite("/repo/src/a.ts")] })).toMatchObject({ effect: "allow" });
    expect(run({ mode: "ask-risky", accesses: [Access.fsRead("/repo/.env")] })).toMatchObject({ effect: "allow" });
  });
});

describe("decide——会话记忆（kimi-code session-approval-history 同款）", () => {
  it("subprocess 询问的记忆键命中 → 放行（memory source）", () => {
    expect(run({
      mode: "ask-risky", name: "tool-shell__bash", approvalRule: "tool-shell__bash(git status)", accesses: [Access.subprocess()],
      sessionAllowed: (k) => k === "tool-shell__bash(git status)",
    })).toMatchObject({ effect: "allow", source: "memory" });
  });
});

import { decomposeCommand, isUnanalyzable } from "./decompose.ts";

describe("decomposeCommand 纯函数（M4-2 T9/B12——Reasonix bash_decompose 参照；MA-02/03 起段保留完整文本）", () => {
  it("① git 复合命令拆段——各段完整文本（MA-02：前缀匹配对全段做，不再截前两词）", () => {
    expect(decomposeCommand("git add . && git push origin main"))
      .toEqual(["git add .", "git push origin main"]);
  });

  it("② 长命令不折叠（MA-03：npm test --watch 不再折叠成 npm test）", () => {
    expect(decomposeCommand("npm run build")).toEqual(["npm run build"]);
    expect(decomposeCommand("pnpm run test:unit")).toEqual(["pnpm run test:unit"]);
    expect(decomposeCommand("npm test --watch")).toEqual(["npm test --watch"]);
  });

  it("③ eval/xargs/嵌套 -c → 返回空数组（require-human）", () => {
    expect(decomposeCommand("eval $(dangerous)")).toEqual([]);
    expect(decomposeCommand("find . | xargs rm")).toEqual([]);
    expect(decomposeCommand("bash -c 'rm -rf /'")).toEqual([]);
  });

  it("④ isUnanalyzable——含 $/反引号/通配符 → true（今天 dangerousGate 放行的三类）", () => {
    expect(isUnanalyzable("echo $HOME")).toBe(true);
    expect(isUnanalyzable("rm -rf $DIR")).toBe(true);
    expect(isUnanalyzable("ls `pwd`")).toBe(true);
    expect(isUnanalyzable("cat *.txt")).toBe(true);
    expect(isUnanalyzable("git status")).toBe(false);
  });
});
