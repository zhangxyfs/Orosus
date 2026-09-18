import { Writable } from "node:stream";
import type { CommandUi } from "@orosus/contracts/module";

/** 可切换掩码的输出代理（密钥回显掩码，用户走查）：maskOn 期间可打印字符 → *，
 *  行编辑控制序列整体透传——退格擦除 \b \b（含空格）、ANSI 光标移动 ESC[…、其余控制符。
 *  readline 的全部回显（含行编辑）都走 output——代理在 rl 构造时注入即可全局生效，无需第二接口抢 stdin。 */
// eslint-disable-next-line no-control-regex -- 掩码就是按控制序列分流：退屏/ANSI 透传、可打印掩成 *
const MASK_PASS_THROUGH = /(\x08 \x08)|(\x1b\[[0-9;]*[A-Za-z])|[^\x00-\x1f\x7f]/g;
export function createMaskingOutput(inner: { write(s: string): void }): Writable & { setMask(on: boolean): void } {
  let mask = false;
  const w = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString("utf8");
      inner.write(mask ? s.replace(MASK_PASS_THROUGH, (m: string, bs: string | undefined, csi: string | undefined) => bs ?? csi ?? "*") : s);
      cb();
    },
  });
  return Object.assign(w, { setMask(on: boolean): void { mask = on; } });
}

/** readline 版 CommandUi（D35）：choose 渲染编号列表读序号、ask、confirm [y/N]。
 *  语言约定（D37/D38）：命令一级英文、二级起中文——items 文案由命令侧给。多级菜单 = 命令内嵌套调用。
 *  askSecret 经宿主的掩码 question（TTY 逐键回显 *；管道无回显天然安全）。 */
export function createReadlineUi(io: { question(q: string): Promise<string>; secretQuestion(q: string): Promise<string> }): CommandUi {
  return {
    ask: async (q) => (await io.question(`${q}: `)).trim(),
    askSecret: async (q) => (await io.secretQuestion(`${q}`)).trim(),
    choose: async (title, items) => {
      for (;;) {
        const lines = [`== ${title} ==`, ...items.map((x, i) => `${i + 1}. ${x.replace(/\n/g, " ")}`)];
        for (const l of lines) process.stdout.write(`${l}\n`);
        const raw = (await io.question("选择序号: ")).trim();
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!;
      }
    },
    confirm: async (q) => /^[yY]/.test((await io.question(`${q} [y/N]: `)).trim()),
  };
}
