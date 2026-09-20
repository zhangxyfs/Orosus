/** raw-mode 按键基座（TUI 批 T0/B5 第 2 层）——按键序列解析器 + 模态接管协议。
 *  ESC 歧义：单按 Esc 与 Alt 前缀共享 \x1b——30ms 窗口内无后续字节判单 ESC（xterm 通例值，
 *  设计空白登记常量）；判定状态跨 chunk 保存（慢终端可把 \x1b[A 拆成两包到达）。
 *  退格 \x7f/\x08 双形态同判（Windows 终端矩阵差异，v1.8 补）。修饰方向键（\x1b[1;2A 系）、
 *  Home/End 等本批不消费的序列按未知 CSI/SS3 整体吞掉——不炸、不把序列字节漏进字符流；
 *  框架化阶段需要时在已知表扩展（KeyEvent 穷举的是本批消费形态）。
 *  模态接管 = 流级 pause + readable 拉取（方案风险节预备形态）：readline 的行编辑消费
 *  （flowing data 模式）随流暂停天然停摆；接管期间只有本件 read() 消费字节，未被消费的
 *  字节留在流缓冲里，resume 后由 readline 依序续收（无回灌、无丢行）。 */

export type KeyEvent =
  | { type: "char"; ch: string } // 可打印字符（含 CJK 多字节拼装后的整字符）
  | { type: "arrow"; dir: "up" | "down" | "left" | "right" }
  | { type: "page"; dir: "up" | "down" } // PageUp/PageDown（\x1b[5~ / \x1b[6~）
  | { type: "esc" } // 30ms 窗口判定的单 ESC
  | { type: "meta"; ch: string } // Alt 组合（\x1b + 单字符，如 \x1bv）
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "tab" };

const ESC = 0x1b;

/** 已知 CSI 表（去 \x1b 前缀的序列 → 事件）；未收录序列整体吞掉（见文件头注）。 */
const CSI_TABLE: Readonly<Record<string, KeyEvent>> = {
  "[A": { type: "arrow", dir: "up" },
  "[B": { type: "arrow", dir: "down" },
  "[C": { type: "arrow", dir: "right" },
  "[D": { type: "arrow", dir: "left" },
  "[5~": { type: "page", dir: "up" },
  "[6~": { type: "page", dir: "down" },
};

/** 已知 SS3 表（应用模式方向键，mintty 等终端的另一发送形态）。 */
const SS3_TABLE: Readonly<Record<string, KeyEvent>> = {
  OA: { type: "arrow", dir: "up" },
  OB: { type: "arrow", dir: "down" },
  OC: { type: "arrow", dir: "right" },
  OD: { type: "arrow", dir: "left" },
};

/** 一个 UTF-8 码点的字节数（按首字节判定；孤立续字节按 1 处理——解码落 U+FFFD，不卡死）。 */
const utf8Len = (lead: number): number =>
  lead < 0x80 ? 1 : lead < 0xc0 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;

/** 按键解析器（纯函数件 + 跨 chunk 状态）。onEvent：30ms 定时器异步判出单 ESC 时的推送口
 *  （模态接管用——等待中的 readKey 需要被定时器唤醒）；缺省时攒进下次 feed/settle 返回。 */
export function createKeyParser(opts?: {
  escWindowMs?: number;
  onEvent?: (e: KeyEvent) => void;
}): {
  feed(buf: Buffer): KeyEvent[]; // 字节 → 事件（不完整序列挂起，下个 chunk 续）
  settle(): KeyEvent[]; // 冲刷挂起的单 ESC（30ms 到点 / 流关闭时）
} {
  const escWindowMs = opts?.escWindowMs ?? 30;
  const onEvent = opts?.onEvent;
  let pending: number[] = [];
  let flushed: KeyEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const armTimer = (): void => {
    cancelTimer();
    timer = setTimeout(() => {
      timer = undefined;
      if (pending.length === 1 && pending[0] === ESC) {
        pending = [];
        const ev: KeyEvent = { type: "esc" };
        if (onEvent !== undefined) onEvent(ev);
        else flushed.push(ev);
      }
    }, escWindowMs);
    timer.unref();
  };

  const drain = (): KeyEvent[] => {
    const out: KeyEvent[] = [];
    for (;;) {
      const b0 = pending[0];
      if (b0 === undefined) break;
      if (b0 === ESC) {
        const b1 = pending[1];
        if (b1 === undefined) {
          armTimer(); // 孤 ESC——窗口内等续字节
          break;
        }
        cancelTimer();
        if (b1 === 0x5b) {
          // CSI：\x1b[ + 参数字节（0x30–0x3F）→ 终字节（0x40–0x7E）
          let end = -1;
          for (let i = 2; i < pending.length; i++) {
            const b = pending[i]!;
            if (b >= 0x40 && b <= 0x7e) {
              end = i;
              break;
            }
          }
          if (end === -1) {
            if (pending.length > 16) {
              pending.shift(); // 畸形防御：丢掉 ESC 字节防缓冲区卡死
              continue;
            }
            break; // 序列未齐——等下个 chunk
          }
          const seq = Buffer.from(pending.slice(0, end + 1)).toString("latin1").slice(1);
          const ev = CSI_TABLE[seq];
          if (ev !== undefined) out.push(ev); // 未知 CSI 整体吞掉
          pending = pending.slice(end + 1);
          continue;
        }
        if (b1 === 0x4f) {
          // SS3：\x1bO + 单字节（应用模式方向键）
          if (pending.length < 3) break;
          const seq = Buffer.from(pending.slice(0, 3)).toString("latin1").slice(1);
          const ev = SS3_TABLE[seq];
          if (ev !== undefined) out.push(ev);
          pending = pending.slice(3);
          continue;
        }
        // Alt 组合：\x1b + 单个 UTF-8 字符
        const len = utf8Len(b1);
        if (pending.length < 1 + len) break; // 多字节未齐
        out.push({ type: "meta", ch: Buffer.from(pending.slice(1, 1 + len)).toString("utf8") });
        pending = pending.slice(1 + len);
        continue;
      }
      if (b0 === 0x0d) {
        out.push({ type: "enter" });
        pending.shift();
        continue;
      }
      if (b0 === 0x7f || b0 === 0x08) {
        out.push({ type: "backspace" });
        pending.shift();
        continue;
      }
      if (b0 === 0x09) {
        out.push({ type: "tab" });
        pending.shift();
        continue;
      }
      const len = utf8Len(b0);
      if (pending.length < len) break; // CJK 等多字节未拼完——等下个 chunk
      out.push({ type: "char", ch: Buffer.from(pending.slice(0, len)).toString("utf8") });
      pending = pending.slice(len);
    }
    return out;
  };

  return {
    feed(buf: Buffer): KeyEvent[] {
      pending.push(...buf);
      return [...flushed.splice(0), ...drain()];
    },
    settle(): KeyEvent[] {
      cancelTimer();
      const out = flushed.splice(0);
      if (pending[0] === ESC) {
        pending.shift();
        out.push({ type: "esc" });
      }
      out.push(...drain());
      return out;
    },
  };
}

/** 模态管理器（接管/恢复协议——菜单与询问的运行时）。
 *  run = 接管（流级 pause 停掉宿主行编辑消费 + readable 拉取喂解析器）→ 执行 fn → 恢复
 *  （摘监听 + resume——放 finally：fn 抛错即 Esc reject 是常态路径，不恢复则 readline 暂停态
 *  死锁）。接管期间 stdin close（Ctrl-D/EOF）时挂起的 readKey 以 esc 冲刷返回——防询问在
 *  已关闭的流上悬死。非 TTY：run 直接抛 D35 同款拒绝式（与 main.ts:121/:143 逐字同源）。 */
export function createModal(io: {
  input: NodeJS.ReadableStream & { setRawMode?(m: boolean): void };
  isTTY: boolean;
  write(s: string): void;
}): {
  run<T>(fn: (readKey: () => Promise<KeyEvent>) => Promise<T>): Promise<T>;
} {
  return {
    async run<T>(fn: (readKey: () => Promise<KeyEvent>) => Promise<T>): Promise<T> {
      if (!io.isTTY) {
        throw new Error("无交互环境（stdin 已关闭）——交互式命令不可用（D35 fail-closed）");
      }
      const input = io.input;
      const queue: KeyEvent[] = [];
      const waiters: ((e: KeyEvent) => void)[] = [];
      let closed = false;
      const dispatch = (e: KeyEvent): void => {
        const w = waiters.shift();
        if (w !== undefined) w(e);
        else queue.push(e);
      };
      const parser = createKeyParser({ onEvent: dispatch });
      const onReadable = (): void => {
        for (;;) {
          const chunk = input.read() as Buffer | null;
          if (chunk === null) break;
          for (const e of parser.feed(chunk)) dispatch(e);
        }
      };
      const onClose = (): void => {
        closed = true;
        for (const e of parser.settle()) dispatch(e);
        for (const w of waiters.splice(0)) w({ type: "esc" });
      };
      const readKey = (): Promise<KeyEvent> => {
        if (closed) return Promise.resolve({ type: "esc" });
        const q = queue.shift();
        if (q !== undefined) return Promise.resolve(q);
        return new Promise<KeyEvent>((resolve) => {
          waiters.push(resolve);
        });
      };
      input.pause(); // 流级暂停：readline（flowing data 消费）随之停摆——见文件头注
      input.on("readable", onReadable);
      input.once("close", onClose);
      try {
        return await fn(readKey);
      } finally {
        input.removeListener("readable", onReadable);
        input.removeListener("close", onClose);
        input.resume(); // 未被消费的字节留在流缓冲，readline 恢复后依序续收
      }
    },
  };
}
