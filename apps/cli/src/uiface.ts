/** CLI 命令交互面装配（m5 T2 起）：readline 基座（menu.ts）+ 全屏 FullApp 适配层。
 *  独立成件（不在 main.ts 顶层脚本里）是为了装配行为可测——viewtext.test.ts 的「装配层接线测试」
 *  直接吃本件（main.ts 是顶层脚本，import 即跑 CLI，测试进不去）。
 *  行模式降级语义：viewText 落 console 多行（内容承载不丢弃）；insertText/attachImage 等注入口
 *  静默丢弃（决策点 9——行模式无文内 chip 机制）。 */

import type { CommandUi, PopupKey, PopupLayout } from "@orosus/contracts/module";
import { createReadlineUi } from "./menu.ts";

/** 装配层需要的 FullApp 最小面（结构类型兼容——FullApp 实例直接可传）。 */
export interface FullAppFace {
  viewText(title: string, text: string, opts?: { layout?: PopupLayout; keys?: Record<string, PopupKey>; owner?: string }): void;
  insertAtCursor(text: string): void;
  showToast(text: string): void;
}

export interface CliUiDeps {
  question(q: string): Promise<string>;
  secretQuestion(q: string): Promise<string>;
  pick?(title: string, items: string[]): Promise<number>;
  notice?(text: string, opts?: { durationMs?: number }): void;
  /** 当前全屏应用；undefined = 行模式。调用期现读——activeApp 的生命周期晚于本对象。 */
  activeApp(): FullAppFace | undefined;
}

export function createCliUi(deps: CliUiDeps): CommandUi {
  return {
    ...createReadlineUi({
      question: deps.question,
      secretQuestion: deps.secretQuestion,
      ...(deps.pick !== undefined ? { pick: deps.pick } : {}),
      ...(deps.notice !== undefined ? { notice: deps.notice } : {}),
    }),
    viewText: (title, text, opts) => {
      const app = deps.activeApp();
      if (app === undefined) {
        // 行模式降级：无弹窗可弹，标题 + 逐行落 console（内容承载不丢弃）
        console.log(`== ${title} ==`);
        for (const l of text.split("\n")) console.log(l);
        return;
      }
      app.viewText(title, text, opts);
    },
  };
}
