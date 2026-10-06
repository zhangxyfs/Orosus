/** 回合结束提示音 · chime 档（2026-10-01 用户拍板选用自制音频 Soft_bright_short_co_#4，
 *  mp3 源件存 docs/prototypes/sounds/、运行资产 wav 化入 src/assets/sounds/）：win = PowerShell
 *  SoundPlayer **直接播音卡输出**（不经系统声音方案——BEL 被无声声音方案吞掉的机器也能响，这正是
 *  chime 档的存在理由）；macOS = afplay；Linux = paplay，缺席回落 aplay。分离进程 spawn——不阻塞
 *  回合、不拖进程退出；播放失败静默（音效是增强体验，ZCode taskNotificationSound 同纪律）。
 *  chime 档**不区分结局**（完成/中断/错误同一声「该回来了」）——响数区分结局是 BEL 档的语义，
 *  两档各取所长；资产固定音量（SoundPlayer 无音量口，「柔和不刺耳」靠选曲本身）。 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 运行资产锚（import.meta.url 相对定位——skill bundled 轨同款源码直跑期形态）。 */
export const TURN_END_SOUND = fileURLToPath(new URL("./assets/sounds/turn-end.wav", import.meta.url));

export type BellMode = "bel" | "chime" | "off";

/** [tui] bell 解析：三态字符串 + 旧布尔兼容（true = bel / false = off——bell.ts 首版语义）；
 *  缺省与非法值回落 chime（2026-10-01 用户拍板「缺省得用 chime」——开箱即有完成音，
 *  想回老行为显式写 bel）。 */
export function resolveBellMode(cfgBell: unknown): BellMode {
  if (cfgBell === true) return "bel";
  if (cfgBell === false) return "off";
  if (cfgBell === "bel" || cfgBell === "chime" || cfgBell === "off") return cfgBell;
  return "chime";
}

/** 可听终态（与 bell.ts bellCount 的非零档同集）：未知终态不响。 */
const AUDIBLE_KINDS = new Set(["completed", "interrupted", "error"]);

export interface ChimeDeps {
	platform?: NodeJS.Platform;
	run?: (cmd: string, args: string[]) => void;
	/** 失败回报（宿主接诊断日志——2026-10-01 实机排障：静默吞错让「没声」无从查因）。 */
	onError?: (stage: "spawn" | "resolve", err: unknown) => void;
}

/** powershell 绝对路径兜底（2026-10-01 实机排障两轮）：spawn("powershell") 走 PATH——终端环境把
 *  System32 族从 PATH 里剥掉时 ENOENT 静默；SystemRoot 是进程必有环境变量，绝对路径免疫。
 *  **必须 path.join 拼——禁反斜杠字面量**：上版模板串里 \S \W 被当转义吞、\x0b 成纵向制表符，
 *  拼出乱码路径 ENOENT（实机「最新进程没声」真因；python heredoc 转义塌方进仓的教训）。 */
function powershellExe(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  return root === undefined ? "powershell" : join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** 播放回合结束音（chime 档）：任一可听终态一声。runner/platform 注入可测；
 *  默认 runner = 分离进程（detached + unref + 静默 stdio + windowsHide 防控制台闪窗）。 */
export function playTurnChime(kind: unknown, deps: ChimeDeps = {}): void {
  if (!AUDIBLE_KINDS.has(kind as string)) return;
  const run = deps.run ?? ((cmd: string, args: string[]): void => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true } as never);
      child.unref();
      child.on?.("error", (err: unknown) => deps.onError?.("spawn", err)); // ENOENT 异步错——spawn 本体不抛
    } catch (err) {
      deps.onError?.("spawn", err);
    }
  });
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "win32") {
      run(powershellExe(), ["-NoProfile", "-c", `(New-Object Media.SoundPlayer '${TURN_END_SOUND.replace(/'/g, "''")}').PlaySync()`]);
    } else if (platform === "darwin") {
      run("afplay", [TURN_END_SOUND]);
    } else {
      run("sh", ["-c", `paplay '${TURN_END_SOUND}' 2>/dev/null || aplay -q '${TURN_END_SOUND}'`]);
    }
  } catch (err) {
    deps.onError?.("resolve", err); // 音效失败不影响主流程——只回报
  }
}
