/** 回合结束提示音 · chime 档（2026-10-01 用户拍板选用自制音频 Soft_bright_short_co_#4，
 *  mp3 源件存 docs/prototypes/sounds/、运行资产 wav 化入 src/assets/sounds/）：win = PowerShell
 *  SoundPlayer **直接播音卡输出**（不经系统声音方案——BEL 被无声声音方案吞掉的机器也能响，这正是
 *  chime 档的存在理由）；macOS = afplay；Linux = paplay，缺席回落 aplay。分离进程 spawn——不阻塞
 *  回合、不拖进程退出；播放失败静默（音效是增强体验，ZCode taskNotificationSound 同纪律）。
 *  chime 档**不区分结局**（完成/中断/错误同一声「该回来了」）——响数区分结局是 BEL 档的语义，
 *  两档各取所长；资产固定音量（SoundPlayer 无音量口，「柔和不刺耳」靠选曲本身）。 */
import { spawn } from "node:child_process";
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
}

/** 播放回合结束音（chime 档）：任一可听终态一声。runner/platform 注入可测；
 *  默认 runner = 分离进程（detached + unref + 静默 stdio + windowsHide 防控制台闪窗）。 */
export function playTurnChime(kind: unknown, deps: ChimeDeps = {}): void {
  if (!AUDIBLE_KINDS.has(kind as string)) return;
  const run = deps.run ?? ((cmd: string, args: string[]): void => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true } as never);
    child.unref();
  });
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "win32") {
      run("powershell", ["-NoProfile", "-c", `(New-Object Media.SoundPlayer '${TURN_END_SOUND.replace(/'/g, "''")}').PlaySync()`]);
    } else if (platform === "darwin") {
      run("afplay", [TURN_END_SOUND]);
    } else {
      run("sh", ["-c", `paplay '${TURN_END_SOUND}' 2>/dev/null || aplay -q '${TURN_END_SOUND}'`]);
    }
  } catch {
    /* 音效失败不影响主流程 */
  }
}
