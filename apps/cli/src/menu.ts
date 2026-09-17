import type { CommandUi } from "@orosus/contracts/module";

/** readline 版 CommandUi（D35）：choose 渲染编号列表读序号、ask、confirm [y/N]。
 *  语言约定（D37/D38）：命令一级英文、二级起中文——items 文案由命令侧给。多级菜单 = 命令内嵌套调用。 */
export function createReadlineUi(io: { question(q: string): Promise<string> }): CommandUi {
  return {
    ask: async (q) => (await io.question(`${q}: `)).trim(),
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
