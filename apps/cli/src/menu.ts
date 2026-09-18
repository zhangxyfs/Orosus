import { Writable } from "node:stream";
import type { CommandUi } from "@orosus/contracts/module";

/** 可静默的输出代理（密钥输入无回显，用户走查）：silence 态吞掉 readline 的全部回显——
 *  逐键回显 * 在真实 Windows 终端层（pnpm 管道 × mintty/winpty × 括号粘贴 × ANSI 支持参差）会碎成
 *  孤星、提示语被错乱的刷新序列吃掉（走查实录）。静默盲输是 ssh/docker login 同款，终端无关、确定性一致。 */
export function createSilenceableOutput(inner: { write(s: string): void }): Writable & { silence(on: boolean): void } {
  let silent = false;
  const w = new Writable({
    write(chunk, _enc, cb) {
      if (!silent) inner.write(chunk.toString("utf8"));
      cb();
    },
  });
  return Object.assign(w, { silence(on: boolean): void { silent = on; } });
}

/** readline 版 CommandUi（D35）：choose 渲染编号列表读序号、ask、confirm [y/N]。
 *  语言约定（D37/D38）：命令一级英文、二级起中文——items 文案由命令侧给。多级菜单 = 命令内嵌套调用。
 *  askSecret 经宿主的静默 question（回显全吞——粘贴密钥无感，手输为盲输）。 */
export function createReadlineUi(io: { question(q: string): Promise<string>; secretQuestion(q: string): Promise<string> }): CommandUi {
  return {
    ask: async (q) => (await io.question(`${q}: `)).trim(),
    askSecret: async (q) => (await io.secretQuestion(q)).trim(),
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
