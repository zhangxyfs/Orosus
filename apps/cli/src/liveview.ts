import { renderMarkdown } from "./markdown.ts";
import { moveUp, clearLine, clearToEnd, dispLines } from "./ansi.ts";

/** 流式活动区（TUI 批 T4/B11 半项）——assistant 正文增量进活动区：缓冲 + 80ms 节流重绘
 *  （整段 renderMarkdown 的渲染形态），工具/事件行先固化活动区再直写；turn 结束 end() 定格
 *  终稿（已在屏内容即固化）。窗口上限 40 行（按原文行数计——标题/fence 的渲染折算差异从简，
 *  执行注记登记）：超出后头部固化，固化切点只在 fence 闭合边界取（v1.8 B1②——切进未闭合块
 *  会把 markdown.ts:36 裸行防御形态永久定格；块内顺延至闭合行、块未闭合退到围栏前）。
 *  固化发生时若头部已上屏内容形态变化（裸行→缩进），自首个差异行起重写；形态未变只认领。
 *  重绘帧 = 逐行 `\x1b[K + 行 + \n` + 尾帧 `\x1b[0J` 清残；上移行数按显示宽折算的视觉行
 *  （ansi.ts——CJK 双宽、转义零宽）。非 TTY 全直通（零 ANSI 零缓冲——管道/--print 现状等价）。 */
export function createLiveView(
  io: { write(s: string): void; isTTY: boolean; columns(): number },
  opts?: { throttleMs?: number; windowLines?: number },
): {
  write(s: string): void;
  activity(text: string): void;
  discard(): void;
  end(): void;
} {
  const throttleMs = opts?.throttleMs ?? 80;
  const windowLines = opts?.windowLines ?? 40;
  if (!io.isTTY) {
    return {
      write: (s) => io.write(s),
      activity: (s) => io.write(s),
      discard(): void {},
      end(): void {},
    };
  }
  let buf = ""; // 活动区未固化原文（重绘时整段 renderMarkdown）
  let drawn = 0; // 屏幕活动区视觉行数（固化行 + 活窗）
  let solidRows = 0; // 顶部已固化视觉行数（增量重绘不重画）
  let dirty = false; // 有未上屏的缓冲变更
  let lastTail: string[] | undefined; // 上一帧活窗渲染行（固化形态比对基准）
  let timer: ReturnType<typeof setTimeout> | undefined;

  const rows = (lines: string[]): number => lines.reduce((n, l) => n + dispLines(l, io.columns()), 0);
  const writeFrame = (lines: string[]): void => {
    for (const l of lines) io.write(`${clearLine}${l}\n`);
    io.write(clearToEnd);
  };

  /** fence 安全切点（固化前 j 行原文）：≥want 的最小闭合边界（顺延至闭合行）；
   *  无则 <want 的最大闭合边界（退到围栏前——0 = 本次不固化）。 */
  const fenceSafeCut = (rawLines: string[], want: number): number => {
    let inCode = false;
    let lastSafe = 0;
    for (let i = 0; i < rawLines.length; i++) {
      if (/^```/.test(rawLines[i]!)) inCode = !inCode;
      const prefixLen = i + 1;
      if (!inCode) {
        if (prefixLen >= want) return prefixLen; // 顺延：闭合行即切点
        lastSafe = prefixLen;
      }
    }
    return lastSafe;
  };

  const redraw = (): void => {
    dirty = false;
    let solid: string[] | undefined;
    const rawLines = buf.split("\n");
    if (rawLines.length > windowLines) {
      const cut = fenceSafeCut(rawLines, rawLines.length - windowLines);
      if (cut > 0) {
        solid = renderMarkdown(rawLines.slice(0, cut).join("\n")).split("\n");
        buf = rawLines.slice(cut).join("\n");
      }
    }
    const tail = buf === "" ? [] : renderMarkdown(buf).split("\n");
    if (solid === undefined) {
      // 增量重绘：固化行不动，只重写活窗
      if (drawn > solidRows) io.write(moveUp(drawn - solidRows));
      writeFrame(tail);
    } else if (drawn === 0) {
      writeFrame([...solid, ...tail]); // 首帧——固化部从未上屏，随帧直写
      solidRows = rows(solid);
    } else {
      const diffIdx = solid.findIndex((l, i) => lastTail?.[i] !== l);
      if (diffIdx === -1) {
        // 头部形态未变——认领为固化行即可，只重写活窗
        if (drawn > solidRows) io.write(moveUp(drawn - solidRows));
        writeFrame(tail);
      } else {
        // 形态变化（裸行防御 → 缩进终态，v1.8 B1②）——自首个差异行起重写
        io.write(moveUp(drawn - solidRows - rows(solid.slice(0, diffIdx))));
        writeFrame([...solid.slice(diffIdx), ...tail]);
      }
      solidRows += rows(solid);
    }
    drawn = solidRows + rows(tail);
    lastTail = tail;
  };

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  /** 冲刷：取消挂起节流；有变更补一次终帧重绘；活动区簿记归零（区域闭合，在屏内容即固化）。 */
  const settle = (): void => {
    cancelTimer();
    if (dirty) redraw();
    drawn = 0;
    solidRows = 0;
    buf = "";
    lastTail = undefined;
  };

  return {
    activity(text: string): void {
      buf += text;
      dirty = true;
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          redraw();
        }, throttleMs);
        timer.unref?.(); // 节流器不拖进程退出（end/write 路径都会冲刷）
      }
    },
    write(s: string): void {
      settle(); // 工具/事件行：先把活动区当前内容固化（终态上屏）再直写——交错序正确
      io.write(s);
    },
    discard(): void {
      // 临时活动区擦除（机制⑤，T7 指示行消费）：内容不固化——已画区域整体上移清尾。
      // 调用方责任：仅用于临时指示区（含已认领行的长区域不适用——擦除范围是整个已画区域）
      cancelTimer();
      if (drawn > 0) io.write(`${moveUp(drawn)}${clearToEnd}`);
      drawn = 0;
      solidRows = 0;
      buf = "";
      dirty = false;
      lastTail = undefined;
    },
    end(): void {
      settle(); // turn 结束：活动区定格终稿，后续 write 直写
    },
  };
}
